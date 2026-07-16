const fs = require('fs');
const path = require('path');
const bs58 = require('bs58');

const FILES = [
  ['LunaTV-config.json', 'LunaTV-config.txt'],
  ['jingjian.json', 'jingjian.txt'],
  ['jin18.json', 'jin18.txt'],
];

function normalizedUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

for (const [inputName, outputName] of FILES) {
  const inputPath = path.join(__dirname, inputName);
  const outputPath = path.join(__dirname, outputName);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`找不到输入文件：${inputName}`);
  }

  const encoded = bs58.encode(Buffer.from(normalizedUtf8(inputPath), 'utf8'));
  fs.writeFileSync(outputPath, encoded, 'utf8');
  console.log(`✅ 已生成 ${outputName}`);
}
