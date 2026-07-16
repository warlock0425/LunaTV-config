const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const FULL_CONFIG_PATH = path.join(ROOT, 'LunaTV-config.json');
const EOL = process.platform === 'win32' ? '\r\n' : '\n';

function readConfig(filePath) {
  const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  if (!Number.isInteger(config.cache_time) || config.cache_time <= 0) {
    throw new Error('cache_time 必须是正整数');
  }

  if (!config.api_site || typeof config.api_site !== 'object' || Array.isArray(config.api_site)) {
    throw new Error('api_site 必须是对象');
  }

  return config;
}

function writeConfig(fileName, config) {
  const outputPath = path.join(ROOT, fileName);
  const content = `${JSON.stringify(config, null, 2)}\n`.replace(/\n/g, EOL);
  fs.writeFileSync(outputPath, content, 'utf8');
  console.log(`✅ 已生成 ${fileName}（${Object.keys(config.api_site).length} 个来源）`);
}

function buildConfigs() {
  const full = readConfig(FULL_CONFIG_PATH);

  const jingjian = {
    cache_time: full.cache_time,
    api_site: Object.fromEntries(
      Object.entries(full.api_site).filter(([, source]) => !source._comment)
    ),
  };

  const jin18 = {
    cache_time: jingjian.cache_time,
    api_site: Object.fromEntries(
      Object.entries(jingjian.api_site).filter(([, source]) => !source.name.startsWith('🔞'))
    ),
  };

  writeConfig('jingjian.json', jingjian);
  writeConfig('jin18.json', jin18);
}

try {
  buildConfigs();
} catch (error) {
  console.error(`❌ 配置生成失败：${error.message}`);
  process.exitCode = 1;
}
