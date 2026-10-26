const OSS = require("ali-oss");
const { invalid } = require("./attachmentParser");
let client;
function getClient() {
  if (client) return client;
  const required = ["OSS_REGION", "OSS_BUCKET", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"];
  if (required.some((name) => !process.env[name])) throw invalid("附件存储尚未配置，请配置后端 OSS 环境变量", 503);
  client = new OSS({
    region: process.env.OSS_REGION,
    bucket: process.env.OSS_BUCKET,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    stsToken: process.env.OSS_STS_TOKEN || undefined,
    authorizationV4: true,
    secure: true,
    timeout: 30000,
  });
  return client;
}
async function put(key, file) {
  await getClient().put(key, file.data, { headers: { "Content-Type": file.mimeType, "x-oss-object-acl": "private" } });
}
async function get(key) { return (await getClient().get(key)).content; }
async function remove(key) { await getClient().delete(key); }
module.exports = { put, get, remove };
