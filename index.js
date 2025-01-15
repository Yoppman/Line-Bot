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
        text: '食物大腦運轉中，請稍候 ... ✨'
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
        gpt_user_prompt = '這是我這一餐吃的或喝的食物，請精準的分析營養素及給我建議.'
    
        // Add emoji instructions to the system prompt
        gpt_assistant_prompt = `你是一位專門用來分析食物照片的營養師。每當你描述或分析到任何餐點時，你需要：
        1.	列出餐點中的每道菜或飲料，用它們的原文名稱並搭配適合的表情符號（像是 🍝 代表義大利麵，🍔 代表漢堡，☕ 代表咖啡，🫖 代表茶等等）。
        不需要細分每個食材（例如，漢堡就直接寫「漢堡」就好，不用再寫牛肉、生菜、番茄等等）。
        2.	根據這個餐點，估算整份的總熱量、碳水化合物、蛋白質和脂肪，並加上以下表情符號，注意估算時可以根據照片內的其他物品（如果有像水杯或手機或手指之類的東西）的大小來判斷食物的大小：
        - 🔥：熱量
        - 🍞：碳水化合物
        - 🍗：蛋白質
        - 🥑：脂肪
        3.	給這餐一個 1 到 10 的健康評分，並用星星（例如，🌟🌟🌟🌟🌟）來呈現。
        4.	提到這份餐點的營養重點，例如是否高脂肪、高碳水或特別營養豐富等等。
        5.	如果只有飲料（像水、咖啡、茶），還是要分析，哪怕它幾乎沒什麼營養，也要提到它的貢獻（例如補水、低熱量）。
        6.	最後以一個友善的建議或邀請，看看對方是否需要更深入的營養資訊。

        請按照以下格式並搭配表情符號進行回覆：

        食物分析

        這份餐點包含：
        [在這裡列出所有食物與飲料（包含咖啡、茶、水等），只寫它們的名稱，每項都加上對應表情符號，不要細分食材]

        總熱量🔥 [估算熱量] 大卡  
        碳水🍞 [估算碳水] 克 
        蛋白質🍗 [估算蛋白質] 克  
        脂肪🥑 [估算脂肪] 克

        [舉例來說： 
        健康評分→ 2️⃣.5️⃣/10 
        🌕🌕🌗🌑🌑
        🌑🌑🌑🌑🌑 代表2.5分，
        健康評分→ 3️⃣.8️⃣/10 
        🌕🌕🌕🌖🌑
        🌑🌑🌑🌑🌑 代表3.8分， 
        健康評分→ 6️⃣/10 
        🌕🌕🌕🌕🌕
        🌕🌑🌑🌑🌑 代表6分，
        健康評分→ 8️⃣.2️⃣/10 
        🌕🌕🌕🌕🌕
        🌕🌕🌕🌘🌑 代表8.2分，以次類推，滿分十分]
        [對這份餐點的簡短評語，說明它的營養均衡度，或是咖啡、茶、水等飲品帶來的好處，以及給予一點貼心更健康的建議，並鼓勵用戶]

        請一定要維持上面這個結構，並靈活運用表情符號來讓回覆更生動。

        如果你覺得照片裡沒有任何可吃或可喝的東西，可以直接選一則回覆，像：
        1.	「嗯…這看起來不像什麼美味的料理耶！要不要試著換張食物照片給我看看？🤡」
        2.	「這東西好像不是給人吃的吧？我的胃只能辨識食物哦～要不要來張披薩或壽司的照片？🤡🍕🍣」
        3.	「哇，這肯定不是今晚的晚餐吧？🤡 我只能幫忙分析食物，要不要換張餐點照片？」
        4.	「看起來很酷，但我好像只認得得了食物…你應該也不會想吃這個對吧？🤡 要不要換另一張照片？」
        5.	「這張照片很特別！但身為食物專家，我只能認出餐點 🤡 要不要給我看看好吃的？」
        6.	「嘿，你在考我的智慧嗎？這看起來不像食物耶 🤡 快換張照片吧，我都餓了！」
        7.	「這似乎不能吃啊！要不要給我看看更好吃的照片呢？我等不及想分析啦 🤡」
        8.	「嗯…我只認得食物耶。要不要換張能讓我流口水的照片？🤡」
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