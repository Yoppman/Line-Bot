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
        // 如果是圖片訊息 (群組裡傳圖片) -> 處理食物分析
        await handleImageMessage(event);
      } else if (event.type === 'memberJoined') {
        // 新成員加入 -> 歡迎訊息
        await handleMemberJoined(event);
      } else if (event.type === 'message' && event.message.type === 'text') {
        // 文字訊息 -> 可能是私訊或群組
        await handleTextMessage(event);
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
        await lineClient.pushMessage(groupId, {
          type: 'text',
          text: welcomeMessage
        });
      }
    } catch (error) {
      console.error('handleMemberJoined Error:', error);
    }
  }

  // 這是新增的文字訊息處理函式
async function handleTextMessage(event) {
  try {
    const { replyToken, message, source } = event;
    const userMessage = message.text;

    if (source.type === 'user') {
      // 私訊聊天：呼叫 ChatGPT
      const responseMsg = await callChatGPTText(userMessage);
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: responseMsg
      });
    } else if (source.type === 'group') {
      // 群組文字訊息，要不要回都看你
      // 這裡示範直接回一句話
      // await lineClient.replyMessage(replyToken, {
      //   type: 'text',
      //   text: '群組目前只支援圖片分析！\n若有相關健康疑問可以私訊我！'
      // });
    }
  } catch (error) {
    console.error('handleTextMessage Error:', error);
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

// ---------- 處理群組圖片訊息 ----------
// 1) Immediately reply "Loading..." to the user
// 2) Obtain userId for the final push
// 3) Call the ChatGPT API
// 4) Push the final ChatGPT result back to the user (or group)

async function handleImageMessage(event) {
  try {
    const { replyToken, message, source } = event;
    const messageId = message.id;

    // 1. 立即回覆「運轉中」訊息
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: '正在辨識你的食物中，請稍候...✨'
    });

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
        await lineClient.pushMessage(groupId, {
          type: 'textV2',
          text: `{user} ${responseMsg}`,
          substitution: {
            "user": {
              "type": "mention",
              "mentionee": {
                "type": "user",
                "userId": profile.userId
              }
            }
          }
        });
    } catch (error) {
        // Handle the case where getProfile fails (e.g., 404 error)
        if (error.statusCode === 404) {
            console.error("User hasn't added the bot as a friend, using fallback message.");
    
            const responseMsg = await callChatGPTAPI(imageBase64);
    
            // Push message without a mention
            await lineClient.pushMessage(groupId, {
                type: 'text',
                text: `${responseMsg} \n記得加入此帳號為好友以獲得最佳體驗：）`, // Fallback message without mention
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

      // 儲存圖片，在此進行

      // 後續若仍要呼叫 ChatGPT 分析
      const responseMsg = await callChatGPTAPI(imageBase64);

      // 這邊使用 pushMessage
      // replyMessage內的replytoken只能使用一次就失效
      // 而且 replyMessage 若超過30秒才回會error
      await lineClient.pushMessage(userId, {
        type: 'text',
        text: responseMsg
      });
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
        temperature: 0.2,
        max_tokens: 512,
        frequency_penalty: 0.0
      });
      // 提取 ChatGPT 的回應內容
      const answer = chatCompletion.choices[0].message.content.trim();
      return answer;
    } catch (error) {
      console.error('callChatGPTAPI Error:', error.response?.data || error.message);
      return '抱歉，目前無法處理這張圖片或問題。';
    }
  }

// ---------- 啟動伺服器 ----------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE Bot server running on port ${port}`);
});