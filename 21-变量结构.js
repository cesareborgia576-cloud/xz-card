/* ★★★ v569：变量结构也走热更（作者：「变量结构也改成热更新」）★★★
   ────────────────────────────────────────────────────────────────────────────
   这一版起，21 的**卡内形态**不再是「真身」，而是「兜底真身 + 远端覆盖」：

     · 卡里仍然装着**完整 schema**（不像 04 那样只剩外壳）——
       理由是 21 与 04 的失败代价不同：
         04 拉不到 = 战斗数字不显示，玩家看得见「坏了」；
         21 拉不到 = 没有 zod 约束，变量**照写但不再被归一/兜底**，
                    老档的脏值（境界写成「筑基」、气血写成 "abc"）会直接进界面，
                    而且**零报错**。所以卡里必须有一份能独立工作的。
     · 开机先问一次远端（xz-card 仓库同一 tag 下的「21-变量结构.js」），拿到就用远端那份；
       拿不到 / 校验不过 / 超时，**老实用卡里这份**，绝不因为热更失败而丢 schema。
     · 所以「改 schema」现在有两条路：
         ① 推 CDN（工具/_gh_push_card.mjs）+ 改这里的 `SCHEMA_REF` 之后不用重导卡；
         ② 极端情况（远端全挂）玩家仍能用卡里那份跑，只是旧一版。

   ⚠ 为什么远端那份**不能再 `import` 一遍 registerMvuSchema**：
     那会给同一个事件挂第二套 eventOn，同一条补丁被两套 schema 各 parse 一次 ——
     第二套会用**旧**的形状去改**新**的数据，等于自己拆自己。
     ⇒ 远端文件必须导出「纯函数 buildSchema(z, _)」，由**这一份**统一注册。
        见下面的 `XZ_SCHEMA_BUILD` 标记与 `__XZ_21_REMOTE__`。
   ──────────────────────────────────────────────────────────────────────────── */

import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';

// 由 Cardwright 从 变量表.yaml 生成（变量表 318a17fd）。要改字段请改变量表再重新生成，不要手改这个文件。
// ★ v77：「/主角信息/伤势状态」已**废除**（用户 2026-10-16 定：「已经有血量了」）。
//   伤病程度一律用 气血/气血上限 的比值表达，不再另开标签字段 ——
//   标签与数值两套口径必然会漂移（写了重伤、血量却是满的这类矛盾最让玩家困惑）。
//   yaml、推导 yaml、本文件三处都已删除该字段，重生成也不会带回来。
// z（Zod 4）与 _（lodash）由酒馆助手注入。每个字段：coerce/preprocess → catch(兜底) → transform(归一) → prefault(默认)。
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const num = (fallback, min, max) => z.coerce.number().catch(fallback).transform(v => _.clamp(finite(v, fallback), min, max)).prefault(fallback);
const anyNum = fallback => z.coerce.number().catch(fallback).transform(v => finite(v, fallback)).prefault(fallback);
const text = fallback => z.preprocess(v => (v == null ? fallback : v), z.coerce.string()).catch(fallback).transform(v => (v.trim() === '' ? fallback : v)).prefault(fallback);
/* ★ v272 起限 30 字；**v572（2026-11-09 用户改口）放宽到 70 字** —— 30 字写不下一句像样的独白。
   超了按**字符**截断而不是字节，
   中文一个字算一个；截断后仍是合法字符串，不会让整条 patch 失败、也不会把别的字段连坐掉。 */
const shortText = (fallback, n) => text(fallback).transform(v => Array.from(String(v)).slice(0, n).join(''));
const flag = fallback => z.preprocess(v => (typeof v === 'string' ? /^(true|1|是|有|开|yes)$/i.test(v.trim()) : v == null ? fallback : Boolean(v)), z.boolean()).catch(fallback).prefault(fallback);
const pick = (values, fallback) => z.enum(values).catch(fallback).prefault(fallback);
// ★ v9：会随版本增长的轴（流派／兵器类型／属性）一律**不固值** ——
//   以前用 pick([...]) 写死 12 路，表外的值会被 .catch 静默改写成别的路
//   （例如以后加第 13 路，老存档的招式会变成「体」—— v43 起兵器只作加成参考，不会被禁用）。
//   route() 的做法是「原样保留 + 只做去空白」，读不懂的路交给引擎兜底，绝不改写玩家数据。
const route = fallback => z.preprocess(
  v => (v == null ? fallback : v),
  z.coerce.string()
).catch(fallback).transform(v => { const s = String(v).trim(); return s === '' ? fallback : s; }).prefault(fallback);
// Objects keep fields the table does not know (an older save, a script of its own): z.looseObject, never the deprecated pass-through API.
const obj = shape => { const schema = z.looseObject(shape); return schema.catch(() => schema.parse({})).prefault({}); };
/* 效果集条目上限：12。
   ★ v77 修：原为 8，而表单（07 的 textToSet）不限行数 —— 玩家写 9~10 条效果时，
   record的 takeRight(8) 会**静默丢掉最前面的 1~2 条**且不报错，
   玩家输入被没收却毫无提示。放宽到 12（引擎实际可承载的上限），并在表单侧显式限流。 */
const record = (item, limit) => { const base = z.record(z.string(), item).catch({}).prefault({}); return limit ? base.transform(data => _(data).entries().takeRight(limit).fromPairs().value()) : base; };
const list = (item, limit) => { const base = z.array(item).catch([]).prefault([]); return limit ? base.transform(data => data.slice(-limit)) : base; };

const QUALITY_CD_DEFAULT = { '凡阶': 1, '黄阶': 2, '玄阶': 2, '地阶': 3, '天阶': 3, '神阶': 4 };
const prepNamedSkill = (primaryKey, extraKeys, defaultCdFn) => v => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out = Object.assign({}, v);
  if (out[primaryKey] == null || String(out[primaryKey]).trim() === '') {
    for (let i = 0; i < extraKeys.length; i++) {
      const alt = out[extraKeys[i]];
      if (alt != null && String(alt).trim() !== '') { out[primaryKey] = alt; break; }
    }
  }
  if (defaultCdFn && out['冷却'] == null) {
    out['冷却'] = defaultCdFn(out['品质']);
  }
  return out;
};
/* 功法体系 = 法术 + 心法 + 神通（用户 2026-11-18 拍板：功法是**体系名**，不是某一档的名字）。
   ⇒ 主动招式那一档叫「法术」，字段归 `已学本领.法术`，主键 `法术名`。
   兜底链保留 `功法名`：开发期中间版本写过这个名字，读到旧值就地搬到 `法术名`。 */
const prepFashu = prepNamedSkill('法术名', ['名称', '功法名', '玄技名', '神通名'], q => {
  const k = String(q || '黄阶').trim();
  return QUALITY_CD_DEFAULT[k] != null ? QUALITY_CD_DEFAULT[k] : 2;
});
const prepXinfa = prepNamedSkill('心法名', ['名称', '法术名', '功法名', '玄技名', '玄诀名']);
const prepShentong = prepNamedSkill('神通名', ['名称', '法术名', '功法名', '玄技名'], () => 6);
const prepLinggen = v => {
  if (typeof v === 'string' && v.trim()) return { '品阶': '伪灵根', '属性': v.trim() };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    let rank = v['品阶'];
    if (rank === '无') rank = '伪灵根';
    if (rank === '圣灵根') rank = '至高灵根';
    let attr = v['属性'];
    if (Array.isArray(attr)) attr = attr.filter(Boolean).join('、');
    return { '品阶': rank, '属性': attr };
  }
  return v;
};
const prepEquipSlot = extraKeys => v => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out = Object.assign({}, v);
  if (out['名称'] == null || String(out['名称']).trim() === '') {
    for (let i = 0; i < extraKeys.length; i++) {
      const alt = out[extraKeys[i]];
      if (alt != null && String(alt).trim() !== '') { out['名称'] = alt; break; }
    }
  }
  return out;
};
const prepDestiny = v => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out = Object.assign({}, v);
  if ((out['气运名'] == null || String(out['气运名']).trim() === '') && out['名称']) {
    out['气运名'] = out['名称'];
  }
  return out;
};
const fashuSchema = z.preprocess(
  prepFashu,
  obj({
    "法术名": text("无"),
    "品质": route("黄阶"),
    "类型": route("主动"),
    "目标": route("单体"),
    "效果": record(text(""), 12),
    "消耗": num(0, 0, 999999),
    "冷却": num(2, 0, 99),
  })
);
const xinfaSchema = z.preprocess(
  prepXinfa,
  obj({
    "心法名": text("无"),
    "品质": route("黄阶"),
    "类型": route("被动"),
    "目标": route("自身"),
    "效果": record(text(""), 12),
    "消耗": num(0, 0, 999999),
  })
);
const shentongSchema = z.preprocess(
  prepShentong,
  obj({
    "神通名": text("无"),
    "品质": route("地阶"),
    "类型": route("主动"),
    "目标": route("单体"),
    "效果": record(text(""), 12),
    "消耗": num(0, 0, 999999),
    "冷却": num(6, 0, 99),
  })
);
const equipItemSchema = (defaultName, extraKeys) => z.preprocess(
  prepEquipSlot(extraKeys),
  obj({
    "名称": text(defaultName),
    "品质": route("黄阶"),
    "效果": text(""),
  })
);
/* ★ 2026-11-18 用户拍板：「法器其实就是法宝的低级版，所以法器改为法宝，不再额外设立」。
   ⇒ 装备三槽：法宝(1) / 防具(1) / 饰品(2)。`法器` 作为**旧键名**在 preprocess 里搬进 `法宝`。 */
const equipGroupSchema = z.preprocess(v => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  var o = Object.assign({}, v);
  if ((o['法宝'] == null || String(o['法宝'] && o['法宝']['名称'] || '').trim() === '' || String(o['法宝'] && o['法宝']['名称'] || '').trim() === '无')
      && o['法器'] != null) { o['法宝'] = o['法器']; }
  return o;
}, obj({
  "法宝": equipItemSchema("无", ["法宝名", "法器名", "武器名"]),
  "防具": equipItemSchema("无", ["防具名"]),
  "饰品": record(equipItemSchema("", ["饰品名"]), 2),
}));
const destinySchema = record(z.preprocess(
  prepDestiny,
  obj({
    "气运名": text(""),
    "品质": route("黄阶"),
    "效果": text(""),
  })
), 3);
const linggenSchema = z.preprocess(
  prepLinggen,
  obj({
    "品阶": route("伪灵根"),
    "属性": z.preprocess(v => (Array.isArray(v) ? v.filter(Boolean).join('、') : v), route("火")),
  })
);

// 顶层保持 z.object：registerMvuSchema 注册时会把它包成 z.looseObject，不要在这里改成 looseObject。
export const Schema = z.object({
  "全局": obj({
    /* ★ v406（用户 2026-10-27）：「这个事件删了，不准每次开局都有。没有事件就空在那就行。」
       原来默认值是一句「苍玄历天渊动荡…」⇒ 每局开局都凭空挂着一条大事件，
       玩家一进游戏就被告知"世界出大事了"，而它根本不是剧情里发生的。
       ⇒ 默认改空串。事件只有剧情真的写了才进这一格。 */
    /* ★★★ v432（用户 2026-10-28，最终口径）：**议论类内容整块搬出变量表**。
       用户原话：「不搞成变量，而是搞成蓝灯世界书，懂吧？如果评论和闲杂事件都在变量里，
       变量就太多了，正文ai会被干扰」「肯定要给ai看啊他妈的，不给ai看，
       那他妈和没发生有什么区别」⇒ 两件事都要满足：
         ① AI 必须看得到（所以只能放**常驻世界书**，不能藏进变量）；
         ② 不能占 MVU 变量表（`变量列表` 条目会把整份 stat_data 序列化进上下文，
            塞几十条议论等于每楼白烧几百 token，还会把模型的注意力带偏）。
       ⇒ `九州热议` / `闲杂事件` / `热议更新日` / `热议事件` / `闲杂更新日` **全部不在 schema 里**。
         它们由 08 的「时讯」专线写进两本常驻世界书条目（见 世界书/变量/时讯·*.md）
         + 聊天变量（`chat_metadata.variables`，只给界面同步读，不进 stat_data）。
       ⚠ 老存档里若还留着 `九州热议` 这一格：MVU 的 looseObject 会原样保留，
         不报错、也不会被读。**不要写迁移脚本去清它** —— 那等于再造一份状态源。
         同理，别为了"兼容老档"把这一格加回来：加了它就又会进 stat_data、又开始干扰。 */
    /* ⚠ v334：`已启事件` 已整格删除（用户：「提前触发去掉吧，就境界触发」）。
       那格原本存"玩家手动提前开启过哪些事"，是 v330 双轴设计的产物；
       现在事件只看境界轴，谁都不需要记"开启过"，留着只会变成第二份状态源。
       ——这也是老账：**同一个状态两个落点**，早晚有一个是错的。
       ⚠ 老存档里若还有这一格，MVU 的 looseObject 会原样留着，不会报错、也不会被读。 */
    /* ⚠ v342：`世界线状态` 已整格删除（用户 2026-10-23：「变量里面的世界线状态删了」）。
       它是按 stage/天数推进的**第二条轴**，与境界轴打架：
       两轴并存时，同一件事可能"境界到了但世界线说没到"，玩家永远等不到。
       现在事件只有一条轴（《事件总表》的 minRank/maxRank），这份变量没有任何读者。
       ⚠ 删的时候漏了这一处 —— 变量表（[InitVar]初始变量.md）与变量更新规则都删了，
         只有 schema 还留着定义，于是它照样被 MVU 建出来、照样躺在存档里，
         看起来"还活着"。这正是本项目的招牌病：同一件事多处声明、只删一处。
         闸 `_v330_event_book.mjs` 第 ⑦ 节现在会扫「世界线状态」四个字，扫到就红。 */
  }),
  /* ★ v296（用户 2026-10-21）：「大位置只能写州+地区，如中州·xxx·城市/势力，
     小位置写具体的如这个城市的哪个地方。不然以后地图怎么显示你在哪」。
     ⇒ 大位置固定三段 `州·域·城/势力`（中文间隔号），域号取《地点-三州地理总纲》的封闭表；
        小位置是那一处里面的具体地方。
     ★ 同时删除 `已知地域`（用户：「这个变量删了，用不到」）：舆图改由「当前所在」+ 剧情阶段点亮。
     ★★★ v465（用户 2026-10-29）：「开局什么都没有，但是地点总是默认显示太一门，这是严重的bug」★★★
       默认值原来是 `中州·三宗域·太一门` / `外门演武场` —— 那是**写死的一处具体地点**。
       开局脚本还没落盘时，`text()` 的 prefault 会把它填进 stat_data，舆图地点块就永远读成「太一门」。
       ⇒ 改空串：没人写过 = 还没落地，舆图那边走 `xzCurSect()` 的 null 分支显示「行旅在外」。
       ⚠ 三处必须同时空：本文件 / 变量表.yaml / 世界书/变量/[InitVar]初始变量.md。
       ⚠ 不许为了"看着不空"改回任何宗名 —— 没数据时不许编数据。 */
  "地理": obj({
    "大位置": text(""),
    "小位置": text(""),
  }),
  /* ★ v210：脚本战斗专用字段。此前它只活在 04 与 08 里，变量表与 schema 都没登记 ——
     「脚本在写、文档没有」正是最典型的一处漂移。模型不写，只由脚本置位。
     ⚠⚠ v214 修：这里一度写成裸 `false` —— z.object() 的每个值**必须是 zod schema**，
        ⇒ 所有开场白的变量初始化全红（用户截图那条）。布尔一律用 flag()。 */
  "时间": obj({
    "日期": text("1年1月1日"),
    "精确时间": text("06:00"),
  }),
  "主角信息": obj({
    "姓名": text(""),
    "性别": route("男"),
    "身份": text(""),
    "年龄": num(0, 0, 2500),
    "境界": route("练气初期"), // ★ v9 不固值：以后新增境界老存档照旧；引擎 REALM_COEFFS 认不出时按 1.15 兜底
    "经验值": num(0, 0, 2000),
    "气血": num(100, 0, 999999),      // 当前气血；归零即败
    "气血上限": num(100, 1, 999999),  // 按境界档位定，突破时上调
    "灵力": num(60, 0, 999999),       // 当前灵力；施展法术、心法与神通要耗
    "灵力上限": num(60, 1, 999999),
    /* 灵根：纯修仙版 —— 无名称、无纯度、无效果；只留「品阶」(string/route) 与「属性」(原玄元属性并入) */
    "灵根": linggenSchema,
    /* 先天气运（金手指）：最多 3 个槽位，主角与 NPC 均可持有 */
    "先天气运": destinySchema,
    /* 天骄档位放宽成文本：以后加「圣子」「道子」这类新档，只改世界书即可，老档不会被截断改写。 */
    "天骄": route("非天骄"),
    "可用四维点": anyNum(0),
    "四维": obj({
      "力量": num(5, 0, 20),
      "敏捷": num(5, 0, 20),
      "体质": num(5, 0, 20),
      "智力": num(5, 0, 20),
    }),
    /* 装备系统：法宝(1) + 防具(1) + 饰品(最多2)。`法器` 已并入 `法宝`（用户的"法器是法宝低级版"口径）。 */
    "装备": equipGroupSchema,
    "已学本领": obj({
      "法术": record(fashuSchema, 30),
      "心法": record(xinfaSchema, 15),
      "神通": record(shentongSchema, 15),
    }),
    /* 大道系统（13 路轻量加伤：木水火土风雷冰 + 剑刀枪重武器特殊武器体） */
    "大道": record(obj({
      "熟练度": num(0, 0, 100),
    }), 16),
    "灵宠": record(obj({
      "名称": text(""),
      "种族": text(""),
      "境界": route("练气初期"), // ★ v9 不固值：以后新增境界（炼虚/合体…）老存档照旧；引擎 REALM_COEFFS 认不出时按 1.15 兜底
      "属性": route("无"), // ★ v9 不固值：以后新增元素不影响老存档
      "品质": route("黄阶"), // ★ v9 不固值：以后新增品阶，老存档照旧；引擎按名查档，认不出按黄阶
      "四维": obj({
        "力量": num(3, 0, 20),
        "敏捷": num(3, 0, 20),
        "体质": num(3, 0, 20),
        "智力": num(2, 0, 20),
      }),
      "技能": list(text(''), 4),
      "饱食度": num(100, 0, 100),
      "性格": text(""),
      "外貌": text(""),
      "出战": flag(false),
    }), 3),
  }),
  "人物列表": record(obj({
    "姓名": text("未知"),
    "性别": route("未知"),
    "身份": text(""),
    "种族": text("人族"),
    "外貌": text("未知"),
    "性格": text("未知"),
    "关系": text(""),
    "好感度": num(50, 0, 100).transform(v => Math.round(v)),
    "心里话": shortText("", 70),
    "境界": route("练气初期"),
    "气血": num(100, 0, 999999),
    "气血上限": num(100, 1, 999999),
    "灵力": num(60, 0, 999999),
    "灵力上限": num(60, 1, 999999),
    "四维": obj({
      "力量": num(1, 0, 20),
      "敏捷": num(1, 0, 20),
      "体质": num(1, 0, 20),
      "智力": num(1, 0, 20),
    }),
    "部位": obj({
      "私处": text("正常"),
      "奶子": text("正常"),
      "大腿": text("正常"),
      "足部": text("正常"),
    }),
    "已学本领": obj({
      "法术": record(fashuSchema, 30),
      "心法": record(xinfaSchema, 15),
      "神通": record(shentongSchema, 15),
    }),
    "装备": equipGroupSchema,
    "势力": text("散修"),
    /* 天骄档位放宽成文本：以后加「圣子」「道子」这类新档，只改世界书即可，老档不会被截断改写。 */
    "天骄": route("非天骄"),
    "灵根": linggenSchema,
    "先天气运": destinySchema,
    "灵宠": record(obj({
      "名称": text(""),
      "种族": text(""),
      "境界": route("练气初期"), // ★ v9 不固值：以后新增境界（炼虚/合体…）老存档照旧；引擎 REALM_COEFFS 认不出时按 1.15 兜底
      "属性": route("无"), // ★ v9 不固值：以后新增元素不影响老存档
      "品质": route("黄阶"), // ★ v9 不固值：以后新增品阶，老存档照旧；引擎按名查档，认不出按黄阶
      "四维": obj({
        "力量": num(3, 0, 20),
        "敏捷": num(3, 0, 20),
        "体质": num(3, 0, 20),
        "智力": num(2, 0, 20),
      }),
      "技能": list(text(''), 4),
      "饱食度": num(100, 0, 100),
      "性格": text(""),
      "外貌": text(""),
    }), 1),
    "在场状态": flag(false),
  }), 20),
  "背包": record(obj({
    "物品名称": text(""),
    "数量": num(1, 0, 99999999), // 普通物品数量不大；**玄币/大宗资源用得上**（上限 9999 万）。★ v80：本作货币叫**玄币**，是背包里一条`类型:材料` 的普通物品（物品名称「玄币」），**没有独立的货币字段**
    "品质": route("黄阶"), // ★ v9 不固值：以后新增品阶，老存档照旧；引擎按名查档，认不出按黄阶
    "类型": z.preprocess(
      v => {
        /* 旧档只有 道具/玄技/玄诀/武器/材料 五类，`法宝` 从来不是旧值 ⇒ 原样透传。 */
        if (v === '玄技') return '法术';
        if (v === '玄诀') return '心法';
        if (v === '武器') return '法宝';
        if (v === '法器') return '法宝';
        return v;
      },
      /* ★ 2026-11-18：枚举全部放宽成 route —— 以后背包新增一类（符箓/功法残卷/丹方…）
         只要改世界书，不用改结构、也不用重导卡，老存档照样兼容。 */
      route("道具")
    ),
    /* ★★★ v330（用户：「道具类的描述改成效果，然后依旧和武器玄诀玄技灵根的效果格式同步；
       丹药不再固定名字，而是根据效果契合就行了」）★★★
       `效果` 是**道具唯一的作用来源**，与四源同一套写法：`机制:数值[:手数]｜描写`，
       多条用中文逗号隔开（`治疗:400，回蓝:30`）。
       名字只是名字：叫「九转还魂丹」但效果写 `中毒:20:3`，吃下去就是中毒。
       ⚠ `描述` 保留，但只作**风味文字**（给人看的），引擎一个字都不读；
         老档把效果写在描述里的，只有"描述本身就是机制串"（`^机制:数值`）才会被当效果读。 */
    "效果": text(""),
    "描述": text(""), // 纯文本描述（风味，不参与结算）
  }), 50),
  /* ★ v292：任务 / 功勋 —— **全局系统**。
     用户原话：「任务千万不要围绕宗门任务去做，而是一个全局的系统，适应所有场所」。
     所以这里刻意**没有**「功德堂 / 悬赏榜 / 军功」这类宗门专属词：
     · 功勋 = 跨场所通用的唯一结算货币（军功只是宗门内部对它的旧称）
     · 阶   = 规模（多大一件事）；来源 = 出处（谁给的）—— 两套轴，别混
     宗门那套（悬赏榜、四阶悬赏）见《宗门任务机制》，它只是「来源=宗门」这一支的具体玩法。
     ⚠ **没有「功勋」这个字段，故意的**：用户 2026-10-21 定「功勋和灵石就是物品里面的材料，
       功勋可以是宗门功勋，也可以是 xxx 家族功勋，名字看是哪个家族给你的，而不是一个专门的变量」。
       ⇒ 功勋是 /背包 里的一条 `类型:材料`，如「太一门功勋」「轩辕氏功勋」，各记各的账。
       （与 v80 定的「玄币是背包一条材料、没有独立货币字段」同一口径，别再给它开数字字段。）
     字段与 变量表.yaml 的「任务」段一一对应，改字段请先改 yaml 再同步此处。 */
  "任务": obj({
    "进行中": record(obj({
      "阶": route("黄阶"),
      /* ★ 2026-11-18 修 v294 报的「来源缺五种」：这里原来写 `route("宗门")`，
         而 route 是「原样保留、不固化可选值」的（那是给流派/兵器这类会增长的轴用的）。
         结果：六种来源只写在注释里，**schema 本身一个都没声明** ——
         剥掉注释后 21 里只剩「宗门」，而 变量表.yaml 与《变量更新规则》都写着六种，
         三处不同集合。模型只看得到 schema 的形状 ⇒ 它只会写「宗门」。
         ⇒ 来源是**真正的封闭枚举**（不像流派会随版本长），该用 pick 固化：
           写错的值回落到「宗门」，与 yaml 的 `取值参考` + `默认` 完全对齐。 */
      "来源": pick(["宗门", "世家", "官府", "市井", "私托", "自定"], "宗门"),
      "委托人": text(""),
      "地点": text(""),
      "目标": shortText("", 30),
      /* ★ v313 删掉「进度」(0~100)：与《变量更新规则》打架 —— 细则第 57 行明写
         「**没有「进度」**：差事只有「在办」与「了结」两态，判据就是「目标」那一句
         有没有做到 —— 不许自己估一个百分比」。
         schema 里留着它，模型就会照着 schema 建字段（schema 就是它唯一看得见的形状），
         于是每个任务都长出一个 AI 瞎估的百分比，细则那句等于白写。
         ⚠ 删除字段必须连写点一起删（细则侧已无写点）；若哪天复活，「目标」那句
           必须改成可判真假的形式，否则无法判断了结。 */
      "期限": text(""),
      "酬劳": text(""), // 用「酬劳」不用「奖励」——它不只来自上对下
    }), 10),
    "已完成": list(shortText("", 24), 30), // 只记「任务名（阶·来源）」
  }),
  /* ★★★ v472：`秘境` 字段**已下架**，这里只留病历 ★★★
     用户：「秘境探索脚本下架，相关条目也下架。」⇒ 2D 像素闯关整层拆除（玩法 + 世界书全清）。

     为什么删字段而不是留着不用：**schema 是模型唯一看得见的结构**，留着它，
     模型每一轮都会照着建一个 `秘境: {名称, 总层, 当前层, 状态, 收获}` ——
     等于我们一边说"没有这玩法了"，一边把它的形状递到模型手里。清数据只治一次，
     不清 schema 就是永远在产新的。

     ⚠ 老档里可能还留着这五个键（存档跟着聊天记录走）。**不用管它**：
       `deepAssign` 是合并，多出来的键不会被任何代码读；界面也不再读它（浮钮一起删了）。
       不要写"清理迁移"——那要动玩家存档，收益为零。
     ⚠ **不许加进任何"字段白名单/合法字段表"**，也不要为了"兼容老档"把它加回来。
     ⚠ 原定义见 `.bak-v472-秘境下架前/21-变量结构.js`（v311 起，五字段 obj）。
       曾经的用途备忘：名称 / 总层(0~9) / 当前层(0~9) / 状态(未开始·探索中·已通关·已退出) / 收获。
       历史上它只由秘境模块 `mjWrite` 写，模型不看不管。 */
});

/* ══════════════════════════════════════════════════════════════════════════
   ★★★ v569：注册入口 —— 先试远端 schema，失败就用卡里这份 ★★★

   远端那份（xz-card 仓库同一 tag 下的「21-变量结构.js」）的约定：
     · 它是一段 **ESM 模块**，`export const Schema = z.object({...})`
     · 它**不带**注册逻辑 —— 注册只有卡里这一处做（见下）。
     · 传它进来的方式是 `import(url)`，拿 `.Schema` 直接注册。

   ⚠ 三条硬要求（缺一条都会让"热更"变成"更坏"）：
     ① **绝不阻塞开机**：4 秒硬超时。超时就用卡里这份立刻注册。
        schema 晚到 = 开局那几条消息拿不到约束，比"卡打不开"轻得多。
     ② **结构不对就不用**：拿到的东西必须能被 zod 认出是 object
        （`_def.type === 'object'` 或 `.shape` 存在）。CDN 返回一页 HTML、
        或者哪天文件形态变了，都不能让 `registerMvuSchema(undefined)` 把
        整条注册链炸掉 —— 那等于所有变量都不再被归一。
     ③ **失败必须出声**：控制台写清楚"用的是卡里那份"。
        静默的后果是「我推了新 schema，玩家那边没生效，而我以为生效了」。

   ⚠ 为什么 21 不能像 04 那样「卡里只留外壳、实现全在 CDN」：
     两者失败代价不同 ——
       04 拉不到：战斗数字不显示，玩家看得见「坏了」，去报障；
       21 拉不到：**没有 zod 约束，变量照写但不再被归一/兜底**，
                 老档脏值（境界写「筑基」、气血写 "abc"）直接进界面，
                 而且零报错、玩家只会觉得"这游戏怪怪的"。
     ⇒ 卡里必须留一份**能独立工作**的完整 schema。远端那份是"覆盖"，不是"依赖"。
   ══════════════════════════════════════════════════════════════════════════ */
