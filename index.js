require('dotenv').config(); // 如果要使用 dotenv
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const line = require('@line/bot-sdk');
const fs = require('fs');  // 用於暫時儲存圖片 (若需要)
const openai = require('openai')

// Prompts
const prompts = require('./prompts.json');

// ---------- 環境變數 ----------
const {
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY
} = process.env;

// ---------- 設定 LINE Bot 客戶端 ----------
const config = {
  channelSecret: LINE_CHANNEL_SECRET,
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN
};

const lineClient = new line.Client(config);

// ------------ 設定openai api---------
const client = new openai.OpenAI({
    apiKey: OPENAI_API_KEY // This is the default and can be omitted
  });

// ---------- 建立 Express App ----------
const app = express();

// Initialize the global store, Why Global Variables Are Problematic
// Multi-instance scaling: If you run multiple Node.js instances (or Docker containers) behind a load balancer, each instance will have its own copy of global.tempFoodData. That means user session data can get lost or inconsistent if the bot routes messages to different instances.
// Data disappears on restart: If your process restarts, you lose the in-memory data.
// Potential memory leaks: If you forget to remove old entries, your Node.js process might grow in memory usage over time.

// Better Approaches
// Redis or an In-Memory Distributed Cache
// If you need ephemeral storage that can be shared across multiple Node instances, a cache like Redis is a common solution.
// You’d store data in Redis keyed by userId:
global.tempFoodData = {};

// ---------- 設定 body parser 並保存原始 body ----------
app.use('/webhook', express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// ---------- Webhook 事件處理 ----------
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;

    for (let event of events) {
      if (event.type === 'message' && event.message.type === 'image') {
        // handle 已經加好友的人 創建user query
        // await handleFollowEvent(event);
        // 如果是圖片訊息 (群組裡傳圖片) -> 處理食物分析
        await handleImageMessage(event);
      } else if (event.type === 'memberJoined') {
        // 新成員加入 -> 歡迎訊息
        await handleMemberJoined(event);
      } else if (event.type === 'message' && event.message.type === 'text') {
        // 文字訊息 -> 可能是私訊或群組
        await handleTextMessage(event);
      } else if (event.type === 'follow') {
        // 加入好友時創建新user在資料庫
        await handleFollowEvent(event);
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook Error:', error);
    return res.status(200).send('Error');
  }
});
  
  // ---------- 處理新成員加入事件 ----------
  async function handleMemberJoined(event) {
    try {
      const { replyToken, message, source } = event;
      const groupId = event.source.groupId; // 群組 ID
      const joinedMembers = event.joined.members; // 新加入的成員資料
  
      for (const member of joinedMembers) {
        const userId = member.userId;
  
        // 可選：獲取成員資料
        const profile = await lineClient.getProfile(userId).catch(() => null);
  
        // 構建歡迎訊息
        const welcomeMessage = profile
          ? `歡迎 ${profile.displayName}！您可以在這個聊天室傳送食物圖片，我會幫您分析！`
          : `歡迎來到這個群組！🎉\n您可以在此聊天中發送食物圖片，我會為您分析！`;
  
        // 傳送歡迎訊息到群組
        await lineClient.replyMessage(replyToken, {
          type: 'text',
          text: welcomeMessage
        });
      }
    } catch (error) {
      console.error('handleMemberJoined Error:', error);
    }
  }

  async function handleFollowEvent(event) {
    try {
      const userId = event.source.userId;

      // 0. Retrieve the user's LINE profile
      let profile = null;
      try {
        profile = await lineClient.getProfile(userId);
      } catch (err) {
        console.error('Failed to fetch user profile:', err.response?.data || err.message);
      }
  
      const userName = profile?.displayName || `LINEUser-${userId.slice(-5)}`; // Fallback to default name if profile is unavailable
  
      // 1. Check if user already exists in your backend
      //    We need an endpoint that looks up by line_user_id.
      //    Example: GET /users?line_user_id={userId}
  
      let userExists = false;
      let existingUserData = null;
      try {
        const res = await axios.get(`https://lipo-out-backend-production.up.railway.app/users/`, {
          params: {
            line_user_id: userId
          }
        });
        // If a user is found, we can mark userExists = true
        existingUserData = res.data;
        userExists = true;
      } catch (err) {
        // If 404 from backend, it means user not found; ignore
        // If other error, handle accordingly
        console.log('User not found or error:', err.response?.data || err.message);
      }
  
      if (!userExists) {
        // 2. Create new user in your backend
        //    "UserCreate" requires at least 'name' (string) and 'goal' (string).
        //    You can pass default values for them if you don’t have any from LINE.
        const newUser = {
          name: userName,
          goal: 'Moderate',
          line_user_id: userId
        };
  
        const createRes = await axios.post(
          'https://lipo-out-backend-production.up.railway.app/users/',
          newUser
        );
        console.log('New user created:', createRes.data);
      }
    } catch (error) {
      console.error('handleFollowEvent Error:', error);
    }
  }

async function handleTextMessage(event) {
  try {
    const { replyToken, message, source } = event;
    const userMessage = message.text;

    if (source.type === 'user') {
      const userId = source.userId;

      // Case 1: user wants to save food record
      if (userMessage === '儲存這筆記錄') {
        // 1. Retrieve the previously stored analysis data
        const tempData = global.tempFoodData[userId];
        if (!tempData) {
          await lineClient.replyMessage(replyToken, {
            type: 'text',
            text: '抱歉，無法找到分析資料，請再試一次。'
          });
          return;
        }

        // 2. Find user’s DB ID via line_user_id
        let dbUserId;
        try {
          const res = await axios.get(`https://lipo-out-backend-production.up.railway.app/users/`, {
            params: { line_user_id: userId }
          });
          // If the user array returns:
          const foundUser = res.data[0]; 
          dbUserId = foundUser.id;
        } catch (err) {
          console.log('User not found error:', err.message);
          // Optionally create the user here if not found,
          // but ideally they should be created upon follow event
          await lineClient.replyMessage(replyToken, {
            type: 'text',
            text: '抱歉，尚未建立用戶資料。請先加我為好友或重新嘗試。'
          });
          return;
        }

        // 3. Send POST /foods to your backend
        const bodyData = {
          user_id: dbUserId,
          food_analysis: tempData.text, // or your own text
          food_photo: tempData.imageBase64,
          protein: tempData.protein,
          carb: tempData.carbohydrates,
          fat: tempData.fat,
          calories: tempData.calories
        };

        try {
          const createFoodRes = await axios.post(
            'https://lipo-out-backend-production.up.railway.app/foods/',
            bodyData
          );
          console.log('Food created:', createFoodRes.data);

          // 4. Inform user
          await lineClient.replyMessage(replyToken, {
            type: 'text',
            text: '已為您儲存此食物紀錄！'
          });

          // Optionally clear the temp data
          delete global.tempFoodData[userId];
        } catch (error) {
          console.log('Create food error:', error.response?.data || error.message);
          await lineClient.replyMessage(replyToken, {
            type: 'text',
            text: '無法儲存此食物紀錄，請稍後再試。'
          });
        }

      // Case 2: user chooses "否"
      } else if (userMessage === '不用了') {
        await lineClient.replyMessage(replyToken, {
          type: 'text',
          text: '好的，沒有儲存這筆資料。'
        });
        delete global.tempFoodData[userId];  // Clean up
      } 
      // Case 3: otherwise, just do your normal ChatGPT text logic
      else {
        const responseMsg = await callChatGPTText(userMessage);
        await lineClient.replyMessage(replyToken, {
          type: 'text',
          text: responseMsg
        });
      }
    }
  } catch (error) {
    console.error('handleTextMessage Error:', error);
  }
}

// ---------- 處理群組圖片訊息 ----------
// 1) Immediately reply "Loading..." to the user
// 2) Obtain userId for the final push
// 3) Call the ChatGPT API
// 4) Push the final ChatGPT result back to the user (or group)

async function handleImageMessage(event) {
  const { replyToken, message, source } = event;
  const messageId = message.id;

  try {

    // 1. 立即回覆「運轉中」訊息
    // await lineClient.replyMessage(replyToken, {
    //   type: 'text',
    //   text: '正在辨識你的食物中，請稍候...✨'
    // });

    // 2. 取得圖片 Buffer
    const stream = await lineClient.getMessageContent(messageId);
    let imageBuffer = Buffer.alloc(0);
    for await (const chunk of stream) {
      imageBuffer = Buffer.concat([imageBuffer, chunk]);
    }
    const imageBase64 = imageBuffer.toString('base64');

    // 3. 依據 event.source.type 決定是群組還是私訊
    if (source.type === 'group') {
      // ============== 群組照片處理邏輯 ==============
      const groupId = source.groupId; 

      try {
        // Attempt to get the user's profile
        const [responseMsg, profile] = await Promise.all([
            callChatGPTAPI(imageBase64),
            lineClient.getProfile(event.source.userId)
        ]);
        
        // Push message with mention
        await lineClient.replyMessage(replyToken, [
          {
            type: 'text',
            text: '正在辨識你的食物中，請稍候...✨'
          },
          {
          type: 'textV2',
          text: `{user} ${responseMsg.text}`,
          substitution: {
            "user": {
              "type": "mention",
              "mentionee": {
                "type": "user",
                "userId": profile.userId
              }
            }
          }
        }]);

    } catch (error) {
        // Handle the case where getProfile fails (e.g., 404 error)
        if (error.statusCode === 404) {
            console.error("User hasn't added the bot as a friend, using fallback message.");
    
            const responseMsg = await callChatGPTAPI(imageBase64);
    
            // Push message without a mention
            await lineClient.replyMessage(replyToken, {
                type: 'text',
                text: `${responseMsg.text} \n記得加入此帳號為好友以獲得最佳體驗：）`, // Fallback message without mention
            });
        } else {
            // Log unexpected errors
            console.error('Unexpected error:', error);
            throw error; // Optionally rethrow if needed
        }
    }

    } else if (source.type === 'user') {
        // ============== 私訊照片處理邏輯 ==============
        const userId = source.userId;

        // 1. Call your ChatGPT API
        const responseMsg = await callChatGPTAPI(imageBase64);
        const { text, carbohydrates, protein, fat, calories } = responseMsg;

        // 2. Check if the text contains digits
        const containsNumber = /\d/.test(text);

        // 3. Build a final reply text
        let finalText = text; // base text from GPT

        // If it contains a number (likely a food analysis), ask if user wants to save
        if (containsNumber) {
          finalText += "\n\n是否要儲存到您的紀錄？";

          // Send message with Quick Replies
          await lineClient.replyMessage(replyToken, {
            type: 'text',
            text: finalText,
            quickReply: {
              items: [
                {
                  type: 'action',
                  action: {
                    type: 'message',
                    label: '是',
                    text: '儲存這筆記錄'
                  }
                },
                {
                  type: 'action',
                  action: {
                    type: 'message',
                    label: '否',
                    text: '不用了'
                  }
                }
              ]
            }
          });

          // Store the data for potential saving
          global.tempFoodData[userId] = {
            imageBase64,
            text,
            carbohydrates,
            protein,
            fat,
            calories
          };

        } else {
          // If no number found, just reply with the text (no Quick Replies)
          await lineClient.replyMessage(replyToken, {
            type: 'text',
            text: finalText
          });
        }
    }

  } catch (error) {
    console.error('handleImageMessage Error:', error);
  }
}

// ---------- 呼叫 ChatGPT API 的函式 ----------
async function callChatGPTAPI(image) {
    try {
      const chatCompletion = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: prompts.gptAssistantPrompt_Mandarin },
          { role: 'user', content:[
                    {"type": "text", "text": prompts.gpt_user_prompt_Mandarin},
                    {"type": "image_url", "image_url": {
                        "url": `data:image/png;base64,${image}`}
                    }
        ] }
        ],
        response_format: { "type": "json_object" },
        temperature: 0.2,
        max_tokens: 512,
        frequency_penalty: 0.0
      });
      // 提取 ChatGPT 的回應內容
      // 若不是食物，營養素為0
      const answer = chatCompletion.choices[0].message.content; 
        // If the answer is a JSON string, parse it
      const parsedAnswer = JSON.parse(answer); // Parse JSON-formatted string

      return parsedAnswer;
    } catch (error) {
      console.error('callChatGPTAPI Error:', error.response?.data || error.message);
      return '抱歉，目前無法處理這張圖片或問題。';
    }
  }

async function callChatGPTText(userText) {
  try {
    const chatCompletion = await client.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: prompts.gpt_systemp_prompt_Mandarin },
        { role: 'user', content: userText }
      ],
      temperature: 0.7,
      max_tokens: 512
    });
    const answer = chatCompletion.choices[0].message.content.trim();
    return answer;
  } catch (error) {
    console.error('callChatGPTText Error:', error.response?.data || error.message);
    return '抱歉，目前無法處理您的訊息。';
  }
}

// ---------- 啟動伺服器 ----------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE Bot server running on port ${port}`);
});