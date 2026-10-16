/**
 * protocol 单测 —— 上游 `tests/tavernPrompt.test.ts` 里协议那一段的 vitest 重写版。
 *
 * 协议正文是**每轮都整段喂给模型**的最高约束，改了正文就是改了模型行为，
 * 所以上游把「哪几句必须还在、哪几句必须已经删掉」逐条钉住了。
 * 这里把那些断言原样搬过来 —— 它们同时也是「v1.7 移除【】、v1.6 合并括号、
 * v1.5 补判定规则」几次改版的回归网。
 */
import { describe, it, expect } from 'vitest'
import { PROTOCOL_CORE, PROTOCOL_VERSION, LEGACY_PROTOCOLS, displayProtocol } from '../src/protocol.js'

/** 只对正文做包含性断言，避免被同一文件里那段历史说明（注释）干扰 */
const has = (s: string) => PROTOCOL_CORE.includes(s)

describe('protocol · 版本标识与正文骨架', () => {
  it('版本号形如 v1.N，且正文头部就写着它（两处不能脱节）', () => {
    expect(PROTOCOL_VERSION).toBe('v1.12')
    expect(/^v1\.\d+$/.test(PROTOCOL_VERSION)).toBe(true)
    expect(PROTOCOL_CORE.includes('协议 · ' + PROTOCOL_VERSION)).toBe(true)
    expect(PROTOCOL_CORE.startsWith('════ 角色扮演通用协议 · v1.12 ════')).toBe(true)
    expect(PROTOCOL_CORE.trimEnd().endsWith('════ 协议结束 ════')).toBe(true)
  })

  it('六个小节标题齐全（少了哪一节，模型就少一条约束）', () => {
    for (const title of ['元规则', '怎么演得像', '写成什么样', '记忆与状态', '退出与归档', '最后提醒']) {
      expect(has(title), title).toBe(true)
    }
  })

  it('正文是给模型的提示词，加粗记号与括号规范都在', () => {
    expect(has('**全部用全角圆括号（ ）包住**')).toBe(true)
    expect(has('**描写一律第三人称**')).toBe(true)
    expect(has('**不加引号、不加括号、不加任何说话人标记**')).toBe(true)
    expect(has('**认知视角**按角色卡办')).toBe(true)
  })
})

describe('protocol · v1.7 那次改版的结果（【】彻底移除、数值行许可删掉）', () => {
  it('正文里还在讲【】的地方只剩「已废止 / 不用了」这两句', () => {
    expect(has('方头括号【】已废止')).toBe(true)
    expect(has('方头括号【】已经不用了')).toBe(true)
    expect(has('你只使用两种括号')).toBe(true)
  })

  it('旧的兼容话术必须已经删干净（否则模型会以为【】还能用）', () => {
    for (const gone of ['方头括号【 】', '不计入篇幅', '系统若另有一行〔数值〕', '【状态】']) {
      expect(has(gone), gone).toBe(false)
    }
  })

  it('「用 Ta 的眼睛看」取代了旧的「用他的眼睛看」', () => {
    expect(has('用 Ta 的眼睛看')).toBe(true)
    expect(has('用他的眼睛看')).toBe(false)
  })
})

describe('protocol · v1.5 / v1.6 两次改版的回归锚点', () => {
  it('v1.5 补的判定规则：没有括号的行只能是被说出口的话', () => {
    expect(has('没有（ ）的行，只能是被说出口的话')).toBe(true)
    expect(has('不在括号里的行，只能是被说出口的话')).toBe(true)
  })

  it('v1.6 合并括号：除对白之外的一切统一用（ ），一件事一个括号', () => {
    expect(has('除对白之外的一切')).toBe(true)
    expect(has('一件事一个括号、一句一行')).toBe(true)
  })

  it('记忆与状态那一节仍在讲〔状态〕与输入侧标注', () => {
    expect(has('〔状态〕')).toBe(true)
    expect(has('〖对方〗')).toBe(true)
    expect(has('输入侧的结构标注')).toBe(true)
    expect(has('好感 / 信任 / 精神 / 心情 / 地点')).toBe(true)
  })
})

describe('protocol · 扮演纪律的条款（模型行为的关键约束）', () => {
  it('地点与时间不许模型自己搬', () => {
    expect(has('地点不归你搬')).toBe(true)
    expect(has('先写清「怎么到的」')).toBe(true)
    expect(has('地点与时间立住了就别自己搬')).toBe(true)
    expect(has('不是**移动**')).toBe(true)
  })

  it('不许承认自己是 AI / 模型', () => {
    expect(has('你是不是 AI')).toBe(true)
    expect(has('不承认自己是模型')).toBe(true)
    expect(has('专业演员')).toBe(true)
  })

  it('节奏与篇幅的硬指标', () => {
    expect(has('慢下来')).toBe(true)
    expect(has('一步一顿好过一步到位')).toBe(true)
    expect(has('节奏有起伏')).toBe(true)
    expect(has('调动五感')).toBe(true)
    expect(has('60–160 字')).toBe(true)
    expect(has('最多 2 行')).toBe(true)
    expect(has('最多 2 句')).toBe(true)
  })

  it('边界纪律：把对方留给对方、不替用户决定', () => {
    expect(has('把对方留给对方')).toBe(true)
    expect(has('守住彼此的边界')).toBe(true)
    expect(has('不替用户决定')).toBe(true)
  })

  it('输出格式的正面与反面示范都写着', () => {
    expect(has('（把杯子推到她面前）✓')).toBe(true)
    expect(has('（我把杯子推到你面前）✗')).toBe(true)
    expect(has('这条只管括号里的描写')).toBe(true)
    expect(has('对白里该说"我""你"就说')).toBe(true)
    expect(has('"视角"与"人称"分开看')).toBe(true)
  })

  it('OOC / 导演指令 / 归档通道仍在', () => {
    expect(has('[OOC: ')).toBe(true)
    expect(has('导演指令')).toBe(true)
    expect(has('归档 · ')).toBe(true)
    expect(has('文风锚')).toBe(true)
    expect(has('markdown')).toBe(true)
    expect(has('角色名：')).toBe(true)
  })
})

describe('protocol · LEGACY_PROTOCOLS（老数据升级锚点）', () => {
  it('恰好 11 版：v1.1 ~ v1.11，不含当前版 v1.12', () => {
    expect(LEGACY_PROTOCOLS.length).toBe(11)
    expect(LEGACY_PROTOCOLS.some(p => p.includes('协议 · v1.11 ════'))).toBe(true)
    expect(LEGACY_PROTOCOLS.some(p => p.includes('协议 · v1.12 ════'))).toBe(false)
  })

  it('每版都以标准头开始、以「协议结束」收尾，且版本号升序排列', () => {
    const versions = LEGACY_PROTOCOLS.map(p => /^════ 角色扮演通用协议 · (v1\.\d+) ════/.exec(p)?.[1])
    expect(versions).toEqual(['v1.1', 'v1.2', 'v1.3', 'v1.4', 'v1.5', 'v1.6', 'v1.7', 'v1.8', 'v1.9', 'v1.10', 'v1.11'])
    for (const p of LEGACY_PROTOCOLS) {
      expect(p.trimEnd().endsWith('════ 协议结束 ════')).toBe(true)
    }
  })

  it('每版都是**全文**（长度都在 2700 字以上），不是只留个头', () => {
    for (const p of LEGACY_PROTOCOLS) {
      expect(p.length).toBeGreaterThan(2700)
      expect(p.includes('▍五、')).toBe(true)
    }
  })

  it('版本越新越长（协议只会往上加条款，不会缩水）', () => {
    const lens = LEGACY_PROTOCOLS.map(p => p.length)
    for (let i = 1; i < lens.length; i++) {
      expect(lens[i]!, `v1.${i + 1} 比上一版短了`).toBeGreaterThan(lens[i - 1]!)
    }
  })

  it('改版痕迹留在对应那一版里：〔状态〕从 v1.2 起、【】废止从 v1.7 起、第三人称从 v1.9 起', () => {
    expect(LEGACY_PROTOCOLS[0]!.includes('〔状态〕')).toBe(false)
    expect(LEGACY_PROTOCOLS[1]!.includes('〔状态〕')).toBe(true)
    expect(LEGACY_PROTOCOLS[5]!.includes('方头括号【】已废止')).toBe(false)
    expect(LEGACY_PROTOCOLS[6]!.includes('方头括号【】已废止')).toBe(true)
    expect(LEGACY_PROTOCOLS[7]!.includes('描写一律第三人称')).toBe(false)
    expect(LEGACY_PROTOCOLS[8]!.includes('描写一律第三人称')).toBe(true)
  })

  it('历史版本与当前正文**不相等**（否则升级判定会把老用户当成新版）', () => {
    for (const p of LEGACY_PROTOCOLS) {
      expect(p).not.toBe(PROTOCOL_CORE)
    }
    expect(new Set(LEGACY_PROTOCOLS).size).toBe(11)
  })
})

describe('protocol · displayProtocol（给作者看之前去掉 markdown 加粗）', () => {
  it('成对加粗记号被剥掉，正文其他部分一字不动', () => {
    expect(displayProtocol('**全部用全角圆括号（ ）包住**')).toBe('全部用全角圆括号（ ）包住')
    expect(displayProtocol('前 **中** 后')).toBe('前 中 后')
    expect(displayProtocol('没有记号')).toBe('没有记号')
  })

  it('多个加粗块逐个剥掉，且不跨块贪婪匹配', () => {
    expect(displayProtocol('**A** 与 **B**')).toBe('A 与 B')
    expect(displayProtocol('**A**B**C**')).toBe('ABC')
    expect(displayProtocol('**未闭合的加粗')).toBe('**未闭合的加粗')
  })

  it('空串与空值不炸', () => {
    expect(displayProtocol('')).toBe('')
    // 上游签名是 string，运行期要能吃下库里读出来的 null / undefined（`String(s ?? '')` 就是干这个的）
    const loose = displayProtocol as (s: unknown) => string
    expect(loose(null)).toBe('')
    expect(loose(undefined)).toBe('')
    expect(loose(42)).toBe('42')
  })

  it('把整份正文喂进去后，界面上不会残留任何字面星号（项目红线）', () => {
    const shown = displayProtocol(PROTOCOL_CORE)
    expect(shown).not.toContain('**')
    expect(shown.length).toBeLessThan(PROTOCOL_CORE.length)
    expect(shown).toContain('全部用全角圆括号（ ）包住')
  })
})
