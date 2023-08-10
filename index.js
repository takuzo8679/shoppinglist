// index.js(shopping.js)

const line = require("@line/bot-sdk");
// LINE アクセストークン設定
const client = new line.Client({
  channelAccessToken: process.env.ACCESS_TOKEN,
});
const AWS = require("aws-sdk");
const docClient = new AWS.DynamoDB.DocumentClient();
const DynamoDB = new AWS.DynamoDB();
const dynamoParam = { TableName: "shopping-list" };

/**
 * 使い方を説明する変数
 * @type {string}
 */
const HOW_TO_USE = `
☆☆☆☆☆☆☆
    使い方
☆☆☆☆☆☆☆
1.買うもの送信して下さい
2.「見せて」と送信すると現在のリストを返します
3.「○○を消して」と送信すると○○をリストから消します
4.「消して」と送信するとリストを空にします
5.個別の削除は今後アップデート予定です。
6.「教えて」と送信するとこのメッセージを再度表示します
使い方のご意見募集中です。
よろしくお願いします！`;

/**
 * main関数
 * フローを記載
 * @param {*} event
 */
exports.handler = async (event) => {
  try {
    console.log(" ◆ EVENT:", event);
    const event_data = JSON.parse(event.body);
    console.log(" ◆ event_data:", JSON.stringify(event_data));
    const messageData = event_data.events && event_data.events[0];
    const { userId } = messageData?.source;
    console.log(" ◆ userId:", userId);
    const { type } = messageData;
    console.log(" ◆ type:", type);

    if (type === "follow") {
      await followEvent(messageData);
    } else if (type === "unfollow") {
      await unFollowEvent(userId);
    } else if (type === "message") {
      console.log(" ◆ Start of MessageEvent");
      await messageEvent(messageData, userId);
      console.log(" ◆ End of MessageEvent");
    } else {
      return;
    }
  } catch (error) {
    console.log(error);
  }
};

/**
 * 応答メッセージ
 * @param {*} messageData: LINEからのリクエストデータ
 * @param {string} text: 応答用に作成したテキスト
 */
const replyMessage = async (messageData, text) => {
  await client
    .replyMessage(messageData.replyToken, { type: "text", text: text })
    .catch((error) => {
      console.log(error);
    });
};

/**
 * フォロー時の処理
 * @param {*} messageData: LINEからのリクエストデータ
 */
const followEvent = async (messageData) => {
  await replyMessage(messageData, HOW_TO_USE);
};

/**
 * フォロー解除時の処理
 * @param {*} messageData: LINEからのリクエストデータ
 */
const unFollowEvent = async (userId) => {
  await client.pushMessage(userId, { type: "text", text: "" }); // 空メッセージをpush。上手くいかないため。
};

/**
 * メッセージ受信時
 * @param {*} messageData: LINEからのリクエストデータ
 * @param {string} userId: リクエスト元のユーザー
 */
const messageEvent = async (messageData, userId) => {
  // 入力データ取得
  const input = messageData.message.text;

  // get list
  if (/.*[見|み]せて$/.test(input)) {
    console.log(" ◆ 取得");
    await client.pushMessage(userId, { type: "text", text: "はい！" });
    const scanResult = await docClient.scan(dynamoParam).promise();
    console.log(" ◆ 結果", scanResult);
    const items = scanResult.Items.map((n) => n.item).join("\n・");
    await replyMessage(messageData, `・${items}`);

    // get how to use
  } else if (/[教|おし]えて$/.test(input)) {
    await replyMessage(messageData, HOW_TO_USE);
    // delete
  } else if (/.+を?[消|け]して$/.test(input)) {
    const inputExtract = input.replace(/を?[消|け]して$/, "");
    await docClient.delete(
      { ...dynamoParam, Key: { item: inputExtract } },
      async (err, data) => {
        if (err) {
          console.log("■ DELETE エラー" + err);
        } else {
          console.log("■ DELETE データ" + data);
        }
      }
    );
    await replyMessage(messageData, `消したよ🗑`);

    // delete all
  } else if (/[消|け]して$/.test(input)) {
    console.log(" ◆ 削除");
    await client.pushMessage(userId, {
      type: "text",
      text: "はい！時間かかるからちょっと待っててね。",
    });
    const apiResult = await deleteAllItems(dynamoParam);
    console.log(" ◆ 結果", apiResult);
    await replyMessage(messageData, "全部消したよ");

    // post
  } else {
    console.log(" ◆ 追加:", input);
    await docClient.put(
      { ...dynamoParam, Item: { item: input } },
      async (err, data) => {
        if (err) {
          console.log("■ PUT エラー" + err);
        } else {
          console.log("■ PUT データ" + data);
        }
      }
    );

    // リクエスト元へレスポンス
    await client.pushMessage(process.env.NOTIFY_ID, {
      type: "text",
      text: `${input}が追加されたよ`,
    });
    // await replyMessage(messageData, `追加したよ📝`);
  }
};

/**
 * DynamoDBの全アイテムを削除する
 * スキャンするとコストがかかるため、テーブルを削除してから再作成する
 * 削除前に情報を保存して再作成時に設定する
 * @param {*} params
 */
const deleteAllItems = async (params) => {
  // テーブル情報を取得する
  const tableInfo = await getTableInfo(params);

  // delete実行
  await deleteTable(params);

  // deleteが完了したのを確認する
  await waitForDeleted(params);

  // 取得したテーブル情報を用いて、テーブル作成用パラメータを生成
  const createParams = {
    AttributeDefinitions: tableInfo.Table.AttributeDefinitions,
    KeySchema: tableInfo.Table.KeySchema,
    ProvisionedThroughput: {
      ReadCapacityUnits:
        tableInfo.Table.ProvisionedThroughput.ReadCapacityUnits,
      WriteCapacityUnits:
        tableInfo.Table.ProvisionedThroughput.WriteCapacityUnits,
    },
    TableName: tableInfo.Table.TableName,
  };

  // create実行
  await createTable(createParams);

  const response = {
    statusCode: 200,
  };

  return response;
};

/**
 * DynamoDBの情報を取得する
 * @param {*} params
 */
const getTableInfo = async (params) => {
  DynamoDB.describeTable(params);
};

/**
 * DynamoDBのテーブルを削除する
 * @param {*} params
 */
const deleteTable = async (params) => {
  DynamoDB.deleteTable(params);
};

/**
 * テーブルの削除が完了されるまで待つ
 * @param {*} params
 */
const waitForDeleted = async (params) => {
  DynamoDB.waitFor("tableNotExists", params);
};

/**
 * DynamoDBのテーブルを作成する
 * @param {*} params
 */
const createTable = async (params) => {
  DynamoDB.createTable(params);
};
