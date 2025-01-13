require('dotenv').config(); // 如果要使用 dotenv
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const line = require('@line/bot-sdk');
const fs = require('fs');  // 用於暫時儲存圖片 (若需要)
const openai = require('openai')

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
  
      // 逐一處理收到的每個事件
      for (let event of events) {
        if (event.type === 'message' && event.message.type === 'image') {
          await handleImageMessage(event);
        } else if (event.type === 'memberJoined') {
          await handleMemberJoined(event);
        }
      }
  
      // 確保回覆 200 OK 給 LINE
      return res.status(200).send('OK');
    } catch (error) {
      console.error('Webhook Error:', error);
      // 為了避免 LINE 認為 webhook 回應失敗，回覆 200
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
          ? `Welcome ${profile.displayName}! 🎉\You can send food pictures in this chat, and I'll analyze them for you!`
          : `Welcome to the group! 🎉\nYou can send food pictures in this chat, and I'll analyze them for you!`;
  
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

// ---------- 處理圖片訊息 ----------
// 1) Immediately reply "Loading..." to the user
// 2) Obtain userId for the final push
// 3) Call the ChatGPT API
// 4) Push the final ChatGPT result back to the user (or group)

async function handleImageMessage(event) {
    try {
      const { replyToken, message } = event;
      const messageId = message.id;
      const groupId = event.source.groupId;  // or groupId / roomId, depending on context
  
      // Step 1: Immediately reply "Loading..." to give feedback
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: 'Processing your image, please wait ... ✨'
      });
  
      // Step 2: Fetch the image buffer from LINE
      const stream = await lineClient.getMessageContent(messageId);
      let imageBuffer = Buffer.alloc(0);
      for await (const chunk of stream) {
        imageBuffer = Buffer.concat([imageBuffer, chunk]);
      }
      const imageBase64 = imageBuffer.toString('base64');
  
      // Step 3: Call ChatGPT API with the image data
      const responseMsg = await callChatGPTAPI(imageBase64);
  
      // Step 4: Push the result to the user once the ChatGPT response is ready
      await lineClient.pushMessage(groupId, {
        type: 'text',
        text: responseMsg
      });
  
    } catch (error) {
      console.error('handleImageMessage Error:', error);
    }
  }

// ---------- 呼叫 ChatGPT API 的函式 ----------
async function callChatGPTAPI(image) {
    try {
        gpt_user_prompt = '\nThis is what I eat or drink now.'
    
        // Add emoji instructions to the system prompt
        gpt_assistant_prompt = `You are a health assistant specialized in analyzing food photos. For every meal described or analyzed, your task is to:
        1. List each **dish** or **beverage** in the meal in the original language, using relevant emojis for each item (e.g., 🍝 for pasta, 🍔 for hamburger, ☕ for coffee, 🫖 for tea, etc.). **You do not need to list individual ingredients within the dish** (e.g., for a hamburger, list "hamburger" instead of "tomato, lettuce, beef, etc.").
        2. Estimate the total calories, carbohydrates, proteins, and fats of the meal, and include the following emojis next to each macronutrient:
            - 🔥 for calories
            - 🍞 for carbohydrates
            - 🍗 for proteins
            - 🥑 for fats
        3. Provide a health rating from 1 to 10, and represent it with stars (e.g., 🌟🌟🌟🌟🌟).
        4. Mention whether the meal is rich in nutrients or contains too much of any specific macronutrient (e.g., high in fats, carbohydrates, etc.).
        5. If the meal only contains drinks like water, coffee, tea, you still need to analyze and include them, even if they have minimal or no macronutrients. Highlight their contribution (e.g., hydration, low-calorie nature) in the analysis.
        6. End with a friendly suggestion or offer to provide more detailed nutritional information if requested.
    
        Format your response consistently as follows, integrating emojis:
    
        Food Rating
        This meal contains:
        [List of food items (dishes and beverages), each with an emoji, including drinks like coffee, tea, or water. Do not list individual ingredients.]
    
        Total calories 🔥 [Estimated total calories] kcal  
        Total carbohydrates 🍞 [Estimated total carbohydrates] grams  
        Total protein 🍗 [Estimated total protein] grams  
        Total fats 🥑 [Estimated total fats] grams  
    
        Health rating [Health rating] 🌟 (Out of 10)  
        [Short analysis of the meal, mentioning nutritional balance, including the contribution of drinks like coffee, tea, or water, and giving friendly advice.]
    
        Always follow this structure for consistency and clarity, and make the response visually engaging by integrating the appropriate emojis.
    
        If you think there is no food or drink in the image, reply with one of the following:
        1. "Hmm... this doesn't look like a delicious dish! How about trying to send another food photo? 🤡"
        2. "This isn't something you'd want to eat! My stomach only recognizes food! How about trying a pizza or sushi? 🤡🍕🍣"
        3. "Wow, this surely isn't tonight's dinner! 🤡 I can only help you analyze food—how about sending a picture of a meal?"
        4. "Looks cool, but I can only recognize food... I guess you didn't want to eat this, right? 🤡 How about sending another food picture?"
        5. "This picture is unique! But as a food expert, I can only identify meals 🤡 Want to send a tasty food photo instead?"
        6. "Hey, this is testing my intelligence! This isn't food, is it? 🤡 Send another food photo; I'm getting hungry!"
        7. "This seems inedible! How about sending a picture of something that looks tastier? I can't wait to analyze it! 🤡"
        8. "Hmm... I only recognize food! How about considering sending a photo that'll make me hungry? 🤡"
        `
      const chatCompletion = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: gpt_assistant_prompt },
          { role: 'user', content:[
                    {"type": "text", "text": gpt_user_prompt},
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