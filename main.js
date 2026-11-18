// ========== 工具函数：敏感信息脱敏 ==========
const mask = (str, startLen = 4, endLen = 4) => {
  if (!str || typeof str !== 'string') return '***'
  if (str.length <= startLen + endLen) return '*'.repeat(str.length)
  return str.slice(0, startLen) + '****' + str.slice(-endLen)
}

// ========== 默认 UA ==========
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// ========== 积分构成还原 ==========
// 逆向自 renderPointsBreakdown()：
//   最终积分 = Base + Plan 加成 + Streak 加成 + Cable 加成
//   Plan  : vip==31 -> +1 | vip==41 -> +1.5 | vip==51 -> +2
//   Streak: >7 天 -> +1 | >14 天 -> +2
//   Cable : IQI quality.score  <80 -> +8 | <85 -> +5 | <90 -> +3 | <=95 -> +2 | >95 -> +1
const planBonus = (vip) => (Number(vip) === 31 ? 1 : Number(vip) === 41 ? 1.5 : Number(vip) === 51 ? 2 : 0)
const streakBonus = (streak) => (Number(streak) > 14 ? 2 : Number(streak) > 7 ? 1 : 0)
const cableBonus = (score) => {
  const s = Number(score)
  if (!s || s <= 0) return 0
  if (s < 80) return 8
  if (s < 85) return 5
  if (s < 90) return 3
  if (s <= 95) return 2
  return 1
}

// ========== 检查模式说明 ==========
// 本脚本只做「检查今天是否已经签到」，不执行签到请求（不 POST /api/user/checkin）。
// 判断依据：积分流水（/api/user/points 的 history）里是否含今天的记录。

const BEIJING_OFFSET_MS = 8 * 3600 * 1000

const beijingDate = (input) => {
  if (input == null) return null
  const ms = typeof input === 'number' ? (input < 1e12 ? input * 1000 : input) : new Date(input).getTime()
  if (!Number.isFinite(ms)) return null
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

const todayBeijing = () => beijingDate(Date.now())

// 从积分流水里判断今天是否真有记录：true / false / null(结构无法解析)
const hasRecordToday = (list) => {
  if (!Array.isArray(list) || list.length === 0) return null
  const today = todayBeijing()
  const dates = list
    .slice(0, 8)
    .map((it) => beijingDate(it?.time ?? it?.createdAt ?? it?.created_at ?? it?.date))
    .filter(Boolean)
  if (!dates.length) return null
  return dates.includes(today)
}

// ========== 检查时段（早 / 晚） ==========
// run.yml 的两条 cron 对应北京时间 10:07（早）与 21:07（晚）。
// GitHub Actions 的 schedule 不保证准时（延迟可达数小时），因此不比对 cron 表达式，
// 而是按「执行时刻的北京时间」判定时段：
//   05:00-17:59 视为早检查 → 无论结果都推送通知
//   其余时间视为晚检查   → 仅在有账号未签到 / 异常时推送通知
const beijingHour = () => new Date(Date.now() + BEIJING_OFFSET_MS).getUTCHours()
const isMorningSlot = () => {
  const h = beijingHour()
  return h >= 5 && h < 18
}

// ========== 浏览器请求头构造 ==========
// 浏览器发起请求时会带上 sec-ch-ua / sec-fetch-* 等一组头部，
// 这些头部与 UA 中的平台、内核大版本必须自洽，否则容易被判为伪造。
const detectPlatform = (ua) => {
  const s = String(ua || '')
  if (/Android/i.test(s)) return { platform: 'Android', mobile: '?1' }
  if (/iPhone|iPad|iPod/i.test(s)) return { platform: 'iOS', mobile: '?1' }
  if (/Windows/i.test(s)) return { platform: 'Windows', mobile: '?0' }
  if (/Macintosh|Mac OS X/i.test(s)) return { platform: 'macOS', mobile: '?0' }
  if (/Linux/i.test(s)) return { platform: 'Linux', mobile: '?0' }
  return { platform: 'macOS', mobile: '?0' }
}

const detectChromeMajor = (ua) => {
  const m = String(ua || '').match(/Chrome\/(\d+)/)
  return m ? m[1] : '140'
}

const buildBrowserHeaders = (ua, domain) => {
  const { platform, mobile } = detectPlatform(ua)
  const major = detectChromeMajor(ua)
  const isChromiumLike = /Chrome|Chromium|Edg\//i.test(String(ua))
  const headers = {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: `https://${domain}`,
    referer: `https://${domain}/console/checkin`,
    'user-agent': ua,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  }
  if (isChromiumLike) {
    headers['sec-ch-ua'] = `"Chromium";v="${major}", "Not=A?Brand";v="24", "Google Chrome";v="${major}"`
    headers['sec-ch-ua-mobile'] = mobile
    headers['sec-ch-ua-platform'] = `"${platform}"`
  }
  return headers
}

// ========== Cookie 结构诊断 ==========
const REQUIRED_COOKIE_FIELDS = [
  { label: 'gld:sess', variants: ['gld:sess', 'gld_sess'] },
  { label: 'gld:sess.sig', variants: ['gld:sess.sig', 'gld_sess.sig'] },
]

const OPTIONAL_COOKIE_FIELDS = [
  { label: 'koa:sess', variants: ['koa:sess', 'koa.sess'] },
  { label: 'koa:sess.sig', variants: ['koa:sess.sig', 'koa.sess.sig'] },
  { label: 'gld:accts', variants: ['gld:accts', 'gld_accts'] },
  { label: 'gld:accts.sig', variants: ['gld:accts.sig', 'gld_accts.sig'] },
]

const parseCookieNames = (cookie) =>
  String(cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=')
      if (eq === -1) return `(缺少name)${part.slice(0, 4)}…`
      return part.slice(0, eq).trim()
    })

const diagnoseCookie = (cookie) => {
  const raw = String(cookie || '')
  const names = parseCookieNames(raw)
  const named = names.filter((n) => !n.startsWith('(缺少name)'))
  const has = (group) => group.variants.some((v) => named.includes(v))
  return {
    names,
    named,
    hasAssign: raw.includes('='),
    missing: REQUIRED_COOKIE_FIELDS.filter((g) => !has(g)).map((g) => g.label),
    optionalMissing: OPTIONAL_COOKIE_FIELDS.filter((g) => !has(g)).map((g) => g.label),
  }
}

// ========== 多账号环境变量收集 ==========
const MAX_ACCOUNT_SLOTS = 20

const splitEnvLines = (value) =>
  String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)

const resolveUaList = (slot) => {
  const candidates =
    slot === 1 ? ['GLADOS_UA'] : [`GLADOS_UA${slot}`, `GLADOS${slot}_UA`]
  for (const name of candidates) {
    const lines = splitEnvLines(process.env[name])
    if (lines.length) return { list: lines, source: name }
  }
  return { list: splitEnvLines(process.env.GLADOS_UA), source: 'GLADOS_UA(回退)' }
}

const collectAccounts = () => {
  const accounts = []
  const seen = new Map()

  for (let slot = 1; slot <= MAX_ACCOUNT_SLOTS; slot++) {
    const envName = slot === 1 ? 'GLADOS' : `GLADOS${slot}`
    const cookies = splitEnvLines(process.env[envName])
    if (!cookies.length) continue

    const { list: uaList, source: uaSource } = resolveUaList(slot)
    cookies.forEach((cookie, i) => {
      if (seen.has(cookie)) {
        console.log(
          `⚠️  ${envName} 中第 ${i + 1} 条 Cookie 与 ${seen.get(cookie)} 中的记录重复，已自动跳过`
        )
        return
      }
      seen.set(cookie, envName)
      const ua = uaList[i] || uaList[0] || DEFAULT_UA
      accounts.push({
        envName,
        cookie,
        ua,
        uaSource: ua === DEFAULT_UA ? '内置默认UA' : uaSource,
      })
    })
  }

  return accounts
}

// ========== GLaDOS 签到状态检查核心逻辑（只检查，不签到） ==========
const checkToday = async () => {
  const notice = []
  const pointsSummary = []
  let okCount = 0
  let failCount = 0
  console.log('========== GLaDOS 签到状态检查任务开始 ==========')
  console.log(`⏰ 检查时段: ${isMorningSlot() ? '早（无论结果都通知）' : '晚（仅未签到/异常时通知）'}`)

  const accounts = collectAccounts()
  if (!accounts.length) {
    console.log('⚠️  未配置 GLADOS / GLADOS2 / GLADOS3… 任一环境变量，跳过检查任务')
    return { notice, okCount, failCount }
  }

  const sources = [...new Set(accounts.map((a) => a.envName))]
  console.log(`📋 共检测到 ${accounts.length} 个账号`)
  console.log(`📋 环境变量来源: ${sources.join('、')}`)

  for (const [index, account] of accounts.entries()) {
    const accountNo = index + 1
    const tag = `账号 ${accountNo}|${account.envName}`
    const anomalies = []
    console.log(`\n[${tag}] ---------- 开始检查 ----------`)
    console.log(`[${tag}] Cookie: ${mask(account.cookie)}`)

    const diag = diagnoseCookie(account.cookie)
    console.log(`[${tag}] Cookie 字段(${diag.named.length}): ${diag.named.join('、') || '无'}`)
    if (!diag.hasAssign) {
      console.log(
        `[${tag}] ⚠️ Cookie 不含 "name=value" 结构，可能只粘贴了值；请从 DevTools → Network → 该请求的 Cookie 请求头整行复制`
      )
    }
    if (diag.missing.length) {
      console.log(
        `[${tag}] ⚠️ 缺少必需字段: ${diag.missing.join('、')}——实测缺任意一项都会返回 code=-2，请重新完整复制 Cookie`
      )
    } else if (diag.optionalMissing.length) {
      console.log(`[${tag}] ℹ️ 未包含可选项: ${diag.optionalMissing.join('、')}（不影响鉴权）`)
    }

    try {
      const domain = process.env.DOMAIN || 'glados.cloud'
      const ua = account.ua
      const headers = { ...buildBrowserHeaders(ua, domain), cookie: account.cookie }

      console.log(`[${tag}] 目标域名: ${domain}`)
      console.log(`[${tag}] UA(${account.uaSource}): ${mask(ua, 8, 8)}`)

      // 1. 账号状态
      console.log(`[${tag}] 正在获取账号状态...`)
      const statusRes = await fetch(`https://${domain}/api/user/status`, { method: 'GET', headers })
      if (!statusRes.ok) throw new Error(`状态接口HTTP错误: ${statusRes.status} ${statusRes.statusText}`)
      const status = await statusRes.json()
      console.log(`[${tag}] 状态接口响应码: ${status?.code ?? '无'}`)
      if (status?.code !== 0) {
        throw new Error(`登录状态异常: ${status?.message || '未知错误'} (code=${status.code})`)
      }
      const leftDays = Number(status?.data?.leftDays)

      // 2. 积分 + 流水 → 判断今天是否已签到
      let currentPoints = null
      let bonusLine = ''
      let checkedInToday = null
      try {
        console.log(`[${tag}] 正在获取积分与流水...`)
        const pointsRes = await fetch(`https://${domain}/api/user/points`, { method: 'GET', headers })
        if (!pointsRes.ok) throw new Error(`积分接口HTTP错误: ${pointsRes.status}`)
        const pointsData = await pointsRes.json()
        if (pointsData?.code !== 0) {
          throw new Error(`获取积分失败: ${pointsData?.message || '未知错误'}`)
        }
        currentPoints = Number(pointsData?.points) || 0
        const streak = pointsData?.streak ?? 0
        const history = pointsData?.history || pointsData?.list || []
        console.log(`[${tag}] 💰 当前积分: ${currentPoints} 点 | 连续签到: ${streak} 天`)
        pointsSummary.push(`账号${accountNo}(${account.envName}): ${currentPoints} 点 / 连续 ${streak} 天`)

        checkedInToday = hasRecordToday(history)
        if (checkedInToday === true) {
          console.log(`[${tag}] ✅ 积分流水含今日记录，今日已签到`)
        } else if (checkedInToday === false) {
          console.log(`[${tag}] ⚠️ 积分流水不含今日记录，今日尚未签到`)
        } else {
          console.log(`[${tag}] ⚠️ 积分流水结构无法解析，无法确认今日是否已签到`)
          anomalies.push({
            level: 'critical',
            text: '积分流水结构无法解析，无法确认今日是否已签到（接口结构可能已变化）',
          })
        }

        // 3. 光缆质量指数（决定 Cable 档加成，最高 +8）
        let iqiScore = null
        try {
          const iqiRes = await fetch(`https://${domain}/api/user/iqi`, { method: 'GET', headers })
          const iqi = await iqiRes.json()
          console.log(`[${tag}] IQI 接口: http=${iqiRes.status} code=${iqi?.code ?? '无'}`)
          if (iqi?.code === 0) {
            // 实测结构：{ code:0, data:{ quality:{ score, level }, bandwidth, latency, benchmark } }
            iqiScore =
              iqi?.data?.quality?.score ?? iqi?.quality?.score ?? iqi?.data?.score ?? null
            if (iqiScore == null) {
              console.log(`[${tag}] IQI 返回结构: ${JSON.stringify(iqi).slice(0, 300)}`)
            } else {
              console.log(`[${tag}] IQI 光缆指数: ${iqiScore} (${iqi?.data?.quality?.level || '?'})`)
            }
          } else {
            console.log(`[${tag}] IQI 取值失败: ${iqi?.message || '未知'} (code=${iqi?.code})`)
          }
        } catch (iqiErr) {
          console.log(`[${tag}] IQI 请求异常: ${iqiErr.message}`)
        }
        const pB = planBonus(status?.data?.vip ?? status?.vip)
        const sB = streakBonus(streak)
        const cB = cableBonus(iqiScore)
        bonusLine =
          `套餐+${pB} / 连续+${sB} / 光缆+${cB}` +
          (iqiScore != null ? `（IQI=${iqiScore}）` : '（IQI 未取到）')
        console.log(`[${tag}] 📈 加成构成: ${bonusLine}`)
      } catch (pointsErr) {
        console.warn(`[${tag}] ⚠️ 积分查询失败: ${pointsErr.message}`)
        pointsSummary.push(`账号${accountNo}(${account.envName}): 查询失败`)
        anomalies.push({ level: 'critical', text: `积分查询失败: ${pointsErr.message}` })
      }

      // 4. 自动兑换
      const autoExchange = String(process.env.AUTO_EXCHANGE || 'true').toLowerCase() !== 'false'
      const exchangeThreshold = Number(process.env.EXCHANGE_THRESHOLD || 500)
      if (autoExchange && currentPoints != null && currentPoints >= exchangeThreshold) {
        try {
          console.log(`[${tag}] 积分 ${currentPoints} ≥ ${exchangeThreshold}，自动兑换 100 天...`)
          const exRes = await fetch(`https://${domain}/api/user/exchange`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ planType: 'plan500' }),
          })
          if (!exRes.ok) throw new Error(`兑换接口HTTP错误: ${exRes.status}`)
          const ex = await exRes.json()
          if (ex?.code !== 0) throw new Error(`${ex?.message || '兑换失败'} (code=${ex?.code})`)
          const remain = Number(ex?.points) || 0
          console.log(`[${tag}] ✅ 自动兑换成功，剩余积分: ${remain}`)
          notice.push(
            `【账号${accountNo}】自动兑换成功`,
            `兑换结果: ${ex?.message || '消耗500积分兑换100天'}`,
            `剩余积分: ${remain}`
          )
        } catch (exErr) {
          console.error(`[${tag}] ⚠️ 自动兑换异常（不影响检查结果）: ${exErr.message}`)
          notice.push(`【账号${accountNo}】自动兑换失败`, `错误: ${exErr.message}`)
        }
      } else if (autoExchange) {
        console.log(
          `[${tag}] 积分 ${currentPoints ?? '未知'} 未达到 ${exchangeThreshold}，本次不兑换`
        )
      } else {
        console.log(`[${tag}] 自动兑换已关闭`)
      }

      if (anomalies.length) {
        console.log(`[${tag}] ⚠️ 检出 ${anomalies.length} 项异常:`)
        anomalies.forEach((item) => console.log(`[${tag}]    · [${item.level}] ${item.text}`))
      }

      console.log(`[${tag}] ${checkedInToday === true ? '✅ 今日已签到' : '❌ 今日未签到/无法确认'}`)
      console.log(`[${tag}] 剩余天数: ${leftDays} 天`)
      console.log(`[${tag}] 当前积分: ${currentPoints != null ? currentPoints + ' 点' : '查询失败'}`)

      const pointsLine =
        `当前积分: ${currentPoints != null ? currentPoints + ' 点' : '查询失败'}` +
        `${bonusLine ? ' | ' + bonusLine : ''}`
      if (checkedInToday === true) {
        notice.push(
          `【账号${accountNo}】今日已签到`,
          `剩余天数: ${leftDays} 天`,
          pointsLine,
          ...anomalies.map((a) => `⚠️ 异常提示: ${a.text}`)
        )
        okCount++
      } else {
        const reason =
          checkedInToday === false
            ? '今日尚未签到，请手动签到'
            : '无法确认今日是否已签到（积分流水解析失败）'
        notice.push(
          `【账号${accountNo}】${reason}`,
          `手动签到地址: https://${domain}/console/checkin`,
          `剩余天数: ${leftDays} 天`,
          pointsLine,
          ...anomalies.map((a) => `⚠️ 异常提示: ${a.text}`)
        )
        failCount++
      }
    } catch (error) {
      console.error(`[${tag}] ❌ 检查失败`)
      console.error(`[${tag}] 错误详情: ${error.message}`)

      notice.push(
        `【账号${accountNo}】检查失败`,
        `错误: ${error.message}`,
        `仓库地址: <${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`
      )
      failCount++
    }
  }

  console.log('\n========== 各账号当前积分 ==========')
  if (pointsSummary.length) {
    pointsSummary.forEach((line) => console.log(`📊 ${line}`))
  } else {
    console.log('📊 无账号积分数据')
  }
  console.log('===================================')
  console.log('\n========== 签到状态检查任务完成 ==========')
  console.log(`📊 统计结果：已签到 ${okCount} 个 | 未签到/异常 ${failCount} 个`)

  const slotLabel = isMorningSlot() ? '早' : '晚'
  const total = okCount + failCount
  const title =
    failCount === 0
      ? `【GLaDOS 检查·${slotLabel}】全部账号今日已签到（${okCount}/${total}）`
      : `【GLaDOS 检查·${slotLabel}】${failCount}/${total} 个账号未签到/异常`
  notice.unshift(title)

  return { notice, okCount, failCount }
}

// ========== 通知推送模块（保持原样） ==========
const notify = async (notice) => {
  console.log('\n========== 通知推送模块开始 ==========')
  if (!process.env.NOTIFY) {
    console.log('⚠️  未配置 NOTIFY 环境变量，跳过推送通知')
    return
  }
  if (!notice || notice.length === 0) {
    console.log('⚠️  无通知内容，跳过推送')
    return
  }
  const options = String(process.env.NOTIFY).split('\n').filter(Boolean)
  console.log(`📋 共配置 ${options.length} 个通知渠道`)
  for (const [idx, option] of options.entries()) {
    const channelNo = idx + 1
    let channelType = '默认(pushplus)'
    try {
      if (option.startsWith('console:')) {
        channelType = '控制台输出'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)
        console.log('———————— 通知内容 ————————')
        notice.forEach((line) => console.log(line))
        console.log('————————————————————————')
        console.log(`[通知 ${channelNo}] ✅ 控制台输出完成`)
      } else if (option.startsWith('wxpusher:')) {
        channelType = 'WxPusher'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)
        const parts = option.split(':')
        const appToken = parts[1]
        const uids = parts.slice(2)
        console.log(`[通知 ${channelNo}] appToken: ${mask(appToken)}`)
        console.log(`[通知 ${channelNo}] 推送UID数量: ${uids.length}`)
        const res = await fetch(`https://wxpusher.zjiecode.com/api/send/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appToken: appToken,
            summary: notice[0],
            content: notice.join('<br>'),
            contentType: 3,
            uids: uids,
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.code !== 1000) throw new Error(`${result.msg} (code=${result.code})`)
        console.log(`[通知 ${channelNo}] ✅ WxPusher 推送成功`)
      } else if (option.startsWith('pushplus:')) {
        channelType = 'PushPlus'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)
        const token = option.split(':')[1]
        console.log(`[通知 ${channelNo}] Token: ${mask(token)}`)
        const res = await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: token,
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.code !== 200) throw new Error(`${result.msg} (code=${result.code})`)
        console.log(`[通知 ${channelNo}] ✅ PushPlus 推送成功`)
      } else if (option.startsWith('bark:')) {
        channelType = 'Bark'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)
        const barkKey = option.split(':')[1]
        console.log(`[通知 ${channelNo}] Bark密钥: ${mask(barkKey)}`)
        const res = await fetch(`https://api.day.app/${barkKey}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: notice[0],
            body: notice.slice(1).join('\n'),
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.code !== 200) throw new Error(`${result.message} (code=${result.code})`)
        console.log(`[通知 ${channelNo}] ✅ Bark 推送成功`)
      } else if (option.startsWith('qyweixin:')) {
        channelType = '企业微信Webhook'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)
        const qyToken = option.split(':')[1]
        console.log(`[通知 ${channelNo}] Webhook Key: ${mask(qyToken)}`)
        const qyweixinNotifyRebotUrl =
          'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + qyToken
        const res = await fetch(qyweixinNotifyRebotUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { content: notice.join('<br>') },
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.errcode !== 0) throw new Error(`${result.errmsg} (errcode=${result.errcode})`)
        console.log(`[通知 ${channelNo}] ✅ 企业微信推送成功`)
      } else {
        channelType = '默认PushPlus(兼容旧格式)'
        console.log(`\n[通知 ${channelNo}] 未识别渠道前缀，使用 ${channelType}`)
        console.log(`[通知 ${channelNo}] Token: ${mask(option)}`)
        const res = await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: option,
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.code !== 200) throw new Error(`${result.msg} (code=${result.code})`)
        console.log(`[通知 ${channelNo}] ✅ PushPlus 推送成功`)
      }
    } catch (error) {
      console.error(`[通知 ${channelNo}] ❌ ${channelType} 推送失败`)
      console.error(`[通知 ${channelNo}] 错误详情: ${error.message}`)
    }
  }
  console.log('\n========== 通知推送模块结束 ==========')
}

// ========== 主入口 ==========
const main = async () => {
  const { notice, failCount } = await checkToday()
  if (!isMorningSlot() && failCount === 0) {
    console.log('\n🌙 晚间检查：全部账号今日已签到，跳过通知')
  } else {
    await notify(notice)
  }
  if (failCount > 0) {
    // 有账号未签到/异常时标记任务失败，GitHub 也会向仓库 owner 发送失败邮件
    process.exitCode = 1
  }
  console.log('\n🎉 全部任务执行完毕')
}

main().catch((err) => {
  console.error('❌ 全局未捕获错误:', err)
  process.exit(1)
})
