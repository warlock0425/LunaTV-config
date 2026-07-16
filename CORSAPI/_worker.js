// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    // 同时兼容文档中的 CONFIG_KV 与旧版 KV 绑定名称
    const kvBinding = env?.CONFIG_KV || env?.KV
    if (kvBinding && typeof globalThis.KV === 'undefined') {
      globalThis.KV = kvBinding
    }
    
    return handleRequest(request, env || {})
  }
}

// 常量配置（避免重复创建）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type, Range, Authorization, Token, X-Requested-With',
  'Access-Control-Max-Age': '86400',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
])

const FORWARDED_REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'content-type', 'if-modified-since',
  'if-none-match', 'range', 'user-agent',
  'referer', 'origin', 'authorization', 'token', 'x-requested-with'
])

const CONFIG_CACHE_TTL_SECONDS = 1800
const CONFIG_FETCH_TIMEOUT_MS = 8000
const ALLOWED_HOSTS_CACHE_MS = 5 * 60 * 1000
const MAX_REDIRECTS = 3
let allowedHostsCache = { expiresAt: 0, hosts: null }

const JSON_SOURCES = {
  'jin18': 'https://raw.githubusercontent.com/Berserker8888/LunaTV-config/refs/heads/main/jin18.json',
  'jingjian': 'https://raw.githubusercontent.com/Berserker8888/LunaTV-config/refs/heads/main/jingjian.json',
  'full': 'https://raw.githubusercontent.com/Berserker8888/LunaTV-config/refs/heads/main/LunaTV-config.json'
}

const FORMAT_CONFIG = {
  '0': { proxy: false, base58: false },
  'raw': { proxy: false, base58: false },
  '1': { proxy: true, base58: false },
  'proxy': { proxy: true, base58: false },
  '2': { proxy: false, base58: true },
  'base58': { proxy: false, base58: true },
  '3': { proxy: true, base58: true },
  'proxy-base58': { proxy: true, base58: true }
}

// Base58 编码函数
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Encode(obj) {
  const str = JSON.stringify(obj)
  const bytes = new TextEncoder().encode(str)

  let intVal = 0n
  for (let b of bytes) {
    intVal = (intVal << 8n) + BigInt(b)
  }

  let result = ''
  while (intVal > 0n) {
    const mod = intVal % 58n
    result = BASE58_ALPHABET[Number(mod)] + result
    intVal = intVal / 58n
  }

  for (let b of bytes) {
    if (b === 0) result = BASE58_ALPHABET[0] + result
    else break
  }

  return result
}

// JSON api 字段前缀替换
function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))
  const newObj = {}
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]
      const urlIndex = apiUrl.indexOf('?url=')
      if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5)
      if (!apiUrl.startsWith(newPrefix)) apiUrl = newPrefix + apiUrl
      newObj[key] = apiUrl
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix)
    }
  }
  return newObj
}

// ---------- 安全版：KV 缓存 ----------
async function fetchJson(url) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timeoutId)
  }
}

async function getCachedJSON(url) {
  const kvAvailable = typeof KV !== 'undefined' && KV && typeof KV.get === 'function'

  if (kvAvailable) {
    const cacheKey = 'CACHE_' + url
    const cached = await KV.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached)
      } catch (e) {
        await KV.delete(cacheKey)
      }
    }
    const data = await fetchJson(url)
    await KV.put(cacheKey, JSON.stringify(data), { expirationTtl: CONFIG_CACHE_TTL_SECONDS })
    return data
  } else {
    return fetchJson(url)
  }
}

// ---------- 安全版：错误日志 ----------
async function logError(type, info) {
  // 保留错误输出，便于调试
  console.error('[ERROR]', type, info)

  // 禁止写入 KV
  return
}

// ---------- 主逻辑 ----------
async function handleRequest(request, env) {
  // 快速处理 OPTIONS 请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
    return errorResponse('Method not allowed', { allowed: ['GET', 'HEAD', 'POST', 'OPTIONS'] }, 405)
  }

  const reqUrl = new URL(request.url)
  const pathname = reqUrl.pathname
  const targetUrlParam = reqUrl.searchParams.get('url')
  const formatParam = reqUrl.searchParams.get('format')
  const prefixParam = reqUrl.searchParams.get('prefix')
  const sourceParam = reqUrl.searchParams.get('source')

  const currentOrigin = reqUrl.origin
  const defaultPrefix = currentOrigin + '/?url='

  // 🩺 健康检查（最常见的性能检查，提前处理）
  if (pathname === '/health') {
    return new Response('OK', { status: 200, headers: CORS_HEADERS })
  }

  // 通用代理请求处理
  if (targetUrlParam) {
    return handleProxyRequest(request, targetUrlParam, currentOrigin, env)
  }

  // JSON 格式输出处理
  if (formatParam !== null) {
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix)
  }

  // 返回首页文档
  return handleHomePage(currentOrigin, defaultPrefix)
}

// ---------- 代理请求处理子模块 ----------
async function handleProxyRequest(request, targetUrlParam, currentOrigin, env) {
  let fullTargetUrl = targetUrlParam
  const urlMatch = request.url.match(/[?&]url=([^&]+(?:&.*)?)/)
  if (urlMatch) {
    try {
      fullTargetUrl = decodeURIComponent(urlMatch[1])
    } catch {
      return errorResponse('Invalid URL encoding', {}, 400)
    }
  }

  let targetURL
  try {
    targetURL = new URL(fullTargetUrl)
  } catch {
    await logError('proxy', { message: 'Invalid URL' })
    return errorResponse('Invalid URL', {}, 400)
  }

  if (targetURL.origin === currentOrigin) {
    return errorResponse('Loop detected: self-fetch blocked', {}, 400)
  }

  let validationError
  try {
    validationError = await validateProxyTarget(targetURL, env, currentOrigin)
  } catch (error) {
    await logError('allowlist', { message: error.message })
    return errorResponse('Unable to load proxy allowlist', {}, 503)
  }
  if (validationError) {
    return errorResponse('Target URL is not allowed', { reason: validationError }, 403)
  }

  try {
    const requestHeaders = pickForwardHeaders(request.headers)
    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: requestHeaders,
      body: request.method === 'POST' ? request.body : undefined,
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 9000)
    let response
    try {
      response = await fetchWithSafeRedirects(proxyRequest, env, controller.signal, currentOrigin)
    } finally {
      clearTimeout(timeoutId)
    }

    const responseHeaders = new Headers(CORS_HEADERS)
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    })
  } catch (err) {
    const safeTarget = redactUrl(fullTargetUrl)
    await logError('proxy', { message: err.message || '代理请求失败', url: safeTarget })
    return errorResponse('Proxy Error', {
      message: err.message || '代理请求失败',
      target: safeTarget,
      timestamp: new Date().toISOString()
    }, 502)
  }
}

function pickForwardHeaders(headers) {
  const safeHeaders = new Headers()
  for (const [key, value] of headers) {
    if (FORWARDED_REQUEST_HEADERS.has(key.toLowerCase())) safeHeaders.set(key, value)
  }
  return safeHeaders
}

function redactUrl(value) {
  try {
    const url = new URL(value)
    for (const key of url.searchParams.keys()) {
      if (/token|key|auth|sign|password|secret/i.test(key)) url.searchParams.set(key, '[REDACTED]')
    }
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return '[invalid URL]'
  }
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }

  if (host.includes(':')) {
    return host === '::' || host === '::1' || host.startsWith('::ffff:') ||
      host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host)
  }

  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false

  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
}

function unwrapProxyUrl(value) {
  let current = value
  for (let depth = 0; depth < 3; depth++) {
    const parsed = new URL(current)
    const nested = parsed.searchParams.get('url')
    if (!nested) return parsed
    current = nested
  }
  return new URL(current)
}

async function getConfiguredSourceHosts() {
  const now = Date.now()
  if (allowedHostsCache.hosts && allowedHostsCache.expiresAt > now) return allowedHostsCache.hosts

  const config = await getCachedJSON(JSON_SOURCES.full)
  const hosts = new Set()
  for (const source of Object.values(config.api_site || {})) {
    try {
      hosts.add(unwrapProxyUrl(source.api).hostname.toLowerCase())
    } catch {
      // 无效来源会由仓库的 verify.js 报告，这里直接忽略。
    }
  }
  allowedHostsCache = { hosts, expiresAt: now + ALLOWED_HOSTS_CACHE_MS }
  return hosts
}

function hostMatchesRule(hostname, rule) {
  const normalizedRule = rule.trim().toLowerCase()
  if (!normalizedRule) return false
  if (normalizedRule.startsWith('*.')) {
    const suffix = normalizedRule.slice(1)
    return hostname.endsWith(suffix) && hostname.length > suffix.length
  }
  return hostname === normalizedRule
}

async function validateProxyTarget(targetURL, env, blockedOrigin = null) {
  if (!['http:', 'https:'].includes(targetURL.protocol)) return '仅支持 HTTP(S)'
  if (blockedOrigin && targetURL.origin === blockedOrigin) return '禁止代理服务递归调用自身'
  if (targetURL.username || targetURL.password) return 'URL 不得包含账号或密码'
  if (targetURL.port && !['80', '443'].includes(targetURL.port)) return '仅允许 80 与 443 端口'
  if (isPrivateHostname(targetURL.hostname)) return '禁止访问本机或私有网络'

  const hostname = targetURL.hostname.toLowerCase()
  const extraRules = String(env.PROXY_ALLOWED_HOSTS || '')
    .split(',')
    .map(rule => rule.trim())
    .filter(Boolean)

  if (extraRules.includes('*')) return null
  if (extraRules.some(rule => hostMatchesRule(hostname, rule))) return null

  const configuredHosts = await getConfiguredSourceHosts()
  if (configuredHosts.has(hostname)) return null
  return '目标主机不在配置来源或 PROXY_ALLOWED_HOSTS 白名单中'
}

async function fetchWithSafeRedirects(request, env, signal, blockedOrigin, redirectCount = 0) {
  const response = await fetch(request, { signal, redirect: 'manual' })
  const location = response.headers.get('location')
  if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response

  if (redirectCount >= MAX_REDIRECTS) throw new Error('Too many redirects')
  const redirectURL = new URL(location, request.url)
  const validationError = await validateProxyTarget(redirectURL, env, blockedOrigin)
  if (validationError) throw new Error(`Unsafe redirect blocked: ${validationError}`)

  const method = [303].includes(response.status) ? 'GET' : request.method
  const redirectedRequest = new Request(redirectURL.toString(), {
    method,
    headers: request.headers,
    body: method === 'POST' ? request.body : undefined,
  })
  return fetchWithSafeRedirects(redirectedRequest, env, signal, blockedOrigin, redirectCount + 1)
}

// ---------- JSON 格式输出处理子模块 ----------
async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) {
      return errorResponse('Invalid format parameter', { format: formatParam }, 400)
    }

    if (sourceParam && !Object.hasOwn(JSON_SOURCES, sourceParam)) {
      return errorResponse('Invalid source parameter', { source: sourceParam }, 400)
    }

    if (prefixParam && !/^https?:\/\//i.test(prefixParam)) {
      return errorResponse('Invalid prefix parameter', { prefix: prefixParam }, 400)
    }

    const selectedSource = JSON_SOURCES[sourceParam || 'full']
    const data = await getCachedJSON(selectedSource)
    
    const newData = config.proxy
      ? addOrReplacePrefix(data, prefixParam || defaultPrefix)
      : data

    if (config.base58) {
      const encoded = base58Encode(newData)
      return new Response(encoded, {
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...CORS_HEADERS },
      })
    } else {
      return new Response(JSON.stringify(newData), {
        headers: { 'Content-Type': 'application/json;charset=UTF-8', ...CORS_HEADERS },
      })
    }
  } catch (err) {
    await logError('json', { message: err.message })
    return errorResponse(err.message, {}, 500)
  }
}

// ---------- 首页文档处理 ----------
async function handleHomePage(currentOrigin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API 中转代理服务</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
    pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .example { background: #e8f5e9; padding: 15px; border-left: 4px solid #4caf50; margin: 20px 0; }
    .section { background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 15px 0; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    table td { padding: 8px; border: 1px solid #ddd; }
    table td:first-child { background: #f5f5f5; font-weight: bold; width: 30%; }
  </style>
</head>
<body>
  <h1>🔄 API 中转代理服务</h1>
  <p>配置来源 API 中转代理，默认仅允许已登记或明确加入白名单的公网接口。</p>
  
  <h2>使用方法</h2>
  <p>中转已允许的 API：在请求 URL 后添加 <code>?url=目标地址</code> 参数</p>
  <pre>${defaultPrefix}<示例API地址></pre>
  
  <h2>配置订阅参数说明</h2>
  <div class="section">
    <table>
      <tr>
        <td>format</td>
        <td><code>0</code> 或 <code>raw</code> = 原始 JSON<br>
            <code>1</code> 或 <code>proxy</code> = 添加代理前缀<br>
            <code>2</code> 或 <code>base58</code> = 原始 Base58 编码<br>
            <code>3</code> 或 <code>proxy-base58</code> = 代理 Base58 编码</td>
      </tr>
      <tr>
        <td>source</td>
        <td><code>jin18</code> = 精简版<br>
            <code>jingjian</code> = 精简版+成人<br>
            <code>full</code> = 完整版（默认）</td>
      </tr>
      <tr>
        <td>prefix</td>
        <td>自定义代理前缀（仅在 format=1 或 3 时生效）</td>
      </tr>
    </table>
  </div>
  
  <h2>配置订阅链接示例</h2>
    
  <div class="section">
    <h3>📦 精简版（jin18）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=jin18</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 精简版+成人（jingjian）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=jingjian</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 完整版（full，默认）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=full</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=full</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <h2>支持的功能</h2>
  <ul>
    <li>✅ 默认仅支持 GET、HEAD 与 OPTIONS</li>
    <li>✅ 仅转发必要且安全的请求头</li>
    <li>✅ 默认仅代理配置内的来源，可用 PROXY_ALLOWED_HOSTS 扩充</li>
    <li>✅ 阻挡本机、私有网络与不安全跳转</li>
    <li>✅ 保留原始响应头（除敏感信息）</li>
    <li>✅ 完整的 CORS 支持</li>
    <li>✅ 超时保护（9 秒）</li>
    <li>✅ 支持多种配置源切换</li>
    <li>✅ 支持 Base58 编码输出</li>
  </ul>
  
  <script>
    document.querySelectorAll('.copy-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const text = document.querySelectorAll('.copyable')[idx].innerText;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerText = '已复制！';
          setTimeout(() => (btn.innerText = '复制'), 1500);
        });
      });
    });
  </script>
</body>
</html>`

  return new Response(html, { 
    status: 200, 
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      ...CORS_HEADERS,
    }
  })
}

// ---------- 统一错误响应处理 ----------
function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}
