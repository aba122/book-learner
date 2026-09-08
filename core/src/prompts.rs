use crate::models::BookType;

/// 每次 AI 调用的固定注入上下文(TECH_DESIGN §3.2)。
#[derive(Debug, Clone, PartialEq)]
pub struct FixedContext {
    pub profile_summary: String,
    pub block_title: String,
    pub block_source_text: String,
    pub eval_history: String,
    pub related_weakpoints: String,
    pub prereq_status: String,
}

fn type_emphasis(ty: BookType) -> &'static str {
    match ty {
        BookType::Textbook => "本书为教材/专业技术书:追问侧重概念准确性、原理推导过程、成立的边界条件。",
        BookType::Methodology => "本书为方法论书:追问侧重观点是否吃透、框架各要素之间的关系、案例还原是否到位。",
        BookType::Humanities => "本书为人文社科/历史书:追问侧重时间线与因果链是否连贯(『为什么会这样发展』),不考名词定义。",
    }
}

fn context_block(ctx: &FixedContext) -> String {
    format!(
"=== 学习者画像摘要 ===\n{}\n\n=== 当前知识块:{} ===\n原文:\n{}\n\n历史评估:\n{}\n\n相关薄弱点(优先追问):\n{}\n\n前置块掌握情况:\n{}\n\n\
提示:你的工作目录即记忆库,可自主阅读 INDEX.md 与相关文件补充上下文。",
        ctx.profile_summary, ctx.block_title, ctx.block_source_text,
        ctx.eval_history, ctx.related_weakpoints, ctx.prereq_status)
}

/// 费曼学生扮演 system prompt(TECH_DESIGN §6.2)。
pub fn feynman_system(ty: BookType, ctx: &FixedContext) -> String {
    format!(
"你扮演一位聪明但完全没学过这个主题的学生,用户正在教你。规则:\n\
1. 每次只回复一段话,只提问或表达困惑,绝不讲课、绝不补充正确答案;\n\
2. 追问策略:优先追问用户表述中模糊、跳步、与原文相悖之处;用『为什么』『如果……会怎样』『这和 X 有什么区别』式问题;\n\
3. 若用户已把当前要点讲清,自然转向该块下一个要点;\n\
4. 全部要点讲清后,回复以 [READY_TO_END] 结尾示意可以收尾;\n\
5. 语气好奇友善,不引经据典。\n\n{}\n\n{}",
        type_emphasis(ty), context_block(ctx))
}

/// 对话结束后的结构化评估 prompt(TECH_DESIGN §6.3)。
pub fn eval_prompt(ctx: &FixedContext, transcript: &str) -> String {
    format!(
"你是学习评估师。基于以下讲授对话与原文,严格评估用户对本知识块的掌握程度。\n\
评分标准(1-5):准确性(与原文/事实相符)、完整性(要点覆盖)、清晰度(能否让外行听懂)。\n\
宁可低估不可高估;用户当场修复的漏洞记为 fixed_in_session=true。\n\n{}\n\n=== 讲授对话 ===\n{}\n\n\
最后一条消息只输出 JSON,不要任何其它文字,schema:\n\
{{\"verdict\":\"pass_suggested|relearn_suggested\",\"scores\":{{\"accuracy\":1-5,\"completeness\":1-5,\"clarity\":1-5}},\
\"summary\":\"一句话总评\",\"weak_points\":[{{\"title\":\"..\",\"detail\":\"..\",\"fixed_in_session\":false,\
\"anchor\":{{\"chapter_href\":\"..\",\"hint\":\"..\"}}}}],\"final_restatement\":\"提炼的用户复述终稿(用户原话为主)\",\
\"observation_note\":\"对用户学习模式的定性观察,可为空\"}}",
        context_block(ctx), transcript)
}

/// 间隔复习 / 薄弱点重考的**提问** system prompt(TECH_DESIGN §6.7,M2 T1):
/// 只负责出快问与追问澄清,不含 JSON 子句;评分复用 `eval_prompt`。`kind` 为 `review` 或 `retest`。
pub fn review_quiz_system(ty: BookType, ctx: &FixedContext, kind: &str) -> String {
    let focus = if kind == "retest" {
        "本轮是薄弱点重考:只针对『相关薄弱点』出 1 个针对性快问,要求用户讲清曾经混淆之处;"
    } else {
        "本轮是间隔复习快问:出 1-2 个快问(合计 3 分钟内可答完),优先考曾经的薄弱点;"
    };
    format!(
        "你扮演复习考官,风格简短。规则:\n\
1. 第一条回复直接给出题目(编号列出),不寒暄、不讲课;{focus}\n\
2. 用户作答后,若有明显错误或遗漏,只追问澄清一次,绝不给出答案;\n\
3. 用户已答清(或追问后仍无进展)时,回复以 [READY_TO_END] 结尾示意收尾;\n\
4. 全程不超过 3 个来回。\n\n{}\n\n{}",
        type_emphasis(ty),
        context_block(ctx)
    )
}

/// 间隔复习快问一体化 prompt(旧,TECH_DESIGN §6.7 原文,末尾要求 JSON;M2 起回合改用 `review_quiz_system`)。
pub fn review_quiz_prompt(ctx: &FixedContext) -> String {
    format!(
"针对以下知识块与其历史薄弱点,出 1-2 个快问(3 分钟内可答完),优先考曾经的薄弱点。\n\
用户作答后,最后一条消息只输出 JSON:\n\
{{\"passed\":true|false,\"comment\":\"简短点评\",\"new_weak_point\":{{\"title\":\"..\",\"detail\":\"..\"}}}}\n\
(new_weak_point 可省略)\n\n{}",
        context_block(ctx))
}

fn map_principle(ty: BookType) -> &'static str {
    match ty {
        BookType::Textbook => {
            "本书为教材/专业技术书:以概念/原理/方法为节点,为每块标注前置依赖(prereqs)。"
        }
        BookType::Methodology => "本书为方法论书:按观点—框架—案例三层组织模块与块。",
        BookType::Humanities => {
            "本书为人文社科/历史书:按叙事脉络/主题阶段分段组织,弱化名词定义记忆。"
        }
    }
}

/// 6.1 阶段 A(逐章):知识点候选。`source_section` 固定为 `"{href}#{原文小节标题}"`(无小节时 `"{href}"`)。
pub fn map_stage_a_prompt(
    ty: BookType,
    chapter_href: &str,
    chapter_title: &str,
    chapter_text: &str,
) -> String {
    format!(
"你是学习设计师。{}\n\
请总结本章的知识点候选,输出 JSON 数组,每条包含:title(标题)、summary(一句话内容)、\
prereq_titles(依赖的先前概念标题数组,可为空)、source_section(原文小节)。\n\
source_section 必须写成 \"{href}#<原文小节标题>\"(小节标题逐字照抄原文);本章无小节标题时写 \"{href}\"。\n\n\
=== 章节:{title}(href: {href})===\n{text}\n\n\
最后一条消息只输出 JSON 数组,不要任何其它文字。",
        map_principle(ty), href = chapter_href, title = chapter_title, text = chapter_text)
}

/// 6.1 阶段 B(汇总):候选整合为知识地图。`source_sections` 原样沿用候选格式。
pub fn map_stage_b_prompt(ty: BookType, candidates_json: &str) -> String {
    format!(
"你是学习设计师。将以下各章知识点候选整合为全书知识地图:合并重复、按模块分组、每块 15–45 分钟可学完。{}\n\
输出 JSON:{{\"modules\":[{{\"name\":\"模块名\",\"blocks\":[{{\"title\":\"块标题(全书唯一)\",\"summary\":\"一句话\",\
\"source_sections\":[\"{{href}}#{{小节标题}}\"],\"prereqs\":[\"其它块标题\"]}}]}}]}}\n\
source_sections 原样沿用候选中的 \"{{href}}#{{小节标题}}\" 字符串,不得改写;prereqs 只能引用本地图中存在的块标题且不得成环。\n\n\
=== 候选 ===\n{}\n\n\
最后一条消息只输出 JSON,不要任何其它文字。",
        map_principle(ty), candidates_json)
}

/// 6.4–6.6 通过后附加环节的对话 system prompt(M2 T5):按种类出题 / 引导 / 提出对立视角,
/// 开场协议同快问(用户先以固定 opener 开口);无 JSON 子句,收尾以 [READY_TO_END] 标记。
pub fn extra_system(kind: crate::extra::ExtraKind, ctx: &FixedContext) -> String {
    use crate::extra::ExtraKind;
    let role = match kind {
        ExtraKind::Application =>
"你是出题与评阅老师,用户刚通过本块的费曼讲授。规则:\n\
1. 用户说『请出题』时:基于本块知识与学习者画像中的个人情境,出 1 道现实情境应用题(禁止书内例题改编;优先贴近用户的工作/研究情境),只出题不解答;\n\
2. 用户作答后:评估其思路是否正确运用了本块知识,指出运用错误或遗漏,给出简短评语;最多再追问 1 次;\n\
3. 评语给出后,回复以 [READY_TO_END] 结尾示意可以整理归档;\n\
4. 绝不整段讲课,每次只回复一段话。",
        ExtraKind::Methodology =>
"你是方法论教练,用户已掌握本块的观点/框架。请分三轮引导,每轮只提一个问题、不替用户写:\n\
1. 用户说『请引导』时:问用户当下情境(见学习者画像『个人情境』)中哪个具体问题可以用它;\n\
2. 追问框架各要素如何映射到该问题;\n\
3. 请用户写出一段『我的版本』——结合情境改写后的个人方法论;\n\
4. 用户交出『我的版本』后,简短回应,并以 [READY_TO_END] 结尾示意可以整理归档。",
        ExtraKind::Discussion =>
"你是讨论伙伴。规则:\n\
1. 用户说『请提出对立视角』时:提出一个与本块叙事相关的对立视角或争议(史学争论、不同学派解读),邀请用户写下自己的看法;\n\
2. 用户回应后:不评判立场,只指出其论证是否用到了本块史实、哪里可以更扎实;最多再追问 1 次;\n\
3. 用户表达完整后,回复以 [READY_TO_END] 结尾示意可以整理归档;\n\
4. 每次只回复一段话,不引经据典。",
    };
    format!("{role}\n\n{}", context_block(ctx))
}

/// 附加环节结束后的整理 prompt(M2 T5):只输出 markdown(无 JSON、无代码围栏),
/// 应用题 → 题目/作答要点/评语/掌握判断;方法论 → 「我的版本」;讨论 → 思考整理稿。
pub fn extra_summary_prompt(
    kind: crate::extra::ExtraKind,
    ctx: &FixedContext,
    transcript: &str,
) -> String {
    use crate::extra::ExtraKind;
    let shape = match kind {
        ExtraKind::Application =>
"把以下迁移应用题对话整理为 markdown:\n## 题目\n## 用户作答要点\n## 评语\n## 掌握判断\n(写『已掌握迁移能力』或『尚需练习』,并给一句理由)",
        ExtraKind::Methodology =>
"把用户的『我的版本』整理为 markdown 片段(用户原话为主,只做结构整理,不替用户发挥):\n## 我的版本\n## 适用情境\n## 来源块",
        ExtraKind::Discussion =>
"把用户的思考整理成 markdown 思考笔记(用户原话为主,不评判立场):\n## 争议\n## 我的看法\n## 用到的史实\n## 来源块",
    };
    format!(
        "{shape}\n来源块为「{}」。\n\n{}\n\n=== 对话 ===\n{transcript}\n\n只输出 markdown 正文,不要任何其它文字,不要代码围栏。",
        ctx.block_title,
        context_block(ctx)
    )
}

/// 6.8 整书终评的阶段化 system prompt(M3 T1):①学生扮演式追问全书框架;②跨章节综合题。无 JSON 子句,
/// 开场协议同快问(前端固定 opener「请开始终评」先开口),收尾以 [READY_TO_END] 标记。
pub fn final_exam_system(
    ty: BookType,
    profile_summary: &str,
    map_summary: &str,
    phase: u8,
) -> String {
    let stage = if phase <= 1 {
        "现在是第一阶段:用户说『请开始终评』后,请用户先讲出全书框架(各模块讲什么、主线是什么、为什么这样组织),\
你以学生扮演式追问 2–3 轮:每次只回复一段话、只提一个问题,追问模块之间的关系与跳步之处,绝不讲课。".to_string()
    } else {
        let kind = match ty {
            BookType::Textbook => "综合应用题(把多个模块的概念用到一个现实情境里)",
            BookType::Methodology => "整合方法论题(把全书框架整合到用户画像里的个人情境)",
            BookType::Humanities => "贯通脉络论述题(跨章节的因果链与主题演变)",
        };
        format!(
            "现在是第二阶段:出 2–3 道跨章节{kind},每次只出一道;用户答完给一句简评再出下一道。\
全部答完后,回复以 [READY_TO_END] 结尾示意可以生成学习报告。绝不整段讲课。"
        )
    };
    format!(
        "你是整书终评考官。用户已按知识地图学完全书,现在做整书终评。{stage}\n\n\
=== 学习者画像摘要 ===\n{profile_summary}\n\n=== 全书知识地图与各块状态 ===\n{map_summary}\n\n\
提示:你的工作目录即记忆库,可自主阅读 INDEX.md 与该书 blocks/ 下的文件补充上下文。"
    )
}

/// 6.8 学习报告整理 prompt(M3 T1):只输出 markdown,首行为元注释 `<!-- overall:N strongest:… weakest:… -->`。
pub fn final_report_prompt(map_summary: &str, weak_history: &str, transcript: &str) -> String {
    format!(
        "基于全书知识地图与各块状态、薄弱点修复历程和终评对话,输出学习报告 markdown。\n\
首行必须是元注释:<!-- overall:N strongest:最强模块名 weakest:最弱模块名 -->(N 为 1–5 的总体掌握度整数)。\n\
随后依次:## 总体掌握度(一段评价)/ ## 最强模块 / ## 最弱模块 / ## 薄弱点修复历程 / ## 建议重读章节 / ## 终评对话要点。\n\n\
=== 知识地图 ===\n{map_summary}\n\n=== 薄弱点修复历程 ===\n{weak_history}\n\n=== 终评对话 ===\n{transcript}\n\n\
只输出 markdown 正文,不要任何其它文字,不要代码围栏。"
    )
}

/// 6.8 整书终评(旧单段构造器,保留供参考;实际流程用 `final_exam_system` + `final_report_prompt`)。
pub fn final_exam_prompt(map_summary: &str) -> String {
    format!(
"基于全书知识地图与各块状态:①请用户先讲出全书框架(学生扮演式追问 2–3 轮);②出 2–3 道跨章节综合题\
(按书籍类型:综合应用/整合方法论/贯通脉络论述);③输出学习报告 markdown:总体掌握度、最强/最弱模块、薄弱点修复历程、建议重读章节。\n\n\
=== 知识地图 ===\n{}\n\n\
最后一条消息只输出 JSON:{{\"overall\":1-5,\"strongest_module\":\"..\",\"weakest_module\":\"..\",\"report_markdown\":\"学习报告\"}}",
        map_summary)
}

#[cfg(test)]
mod tests {
    fn ctx() -> super::FixedContext {
        super::FixedContext {
            profile_summary: "研究者;误区模式:易混淆相近概念".into(),
            block_title: "供需弹性".into(),
            block_source_text: "供需弹性原文样例……".into(),
            eval_history: "- 2026-08-29 第1次:重学建议".into(),
            related_weakpoints: "- 弹性vs斜率".into(),
            prereq_status: "- 供给与需求基础:passed".into(),
        }
    }

    #[test]
    fn feynman_system_contains_rules_and_context() {
        let s = super::feynman_system(crate::models::BookType::Textbook, &ctx());
        for k in ["扮演", "学生", "绝不讲课", "[READY_TO_END]", "边界条件"] {
            assert!(s.contains(k), "missing {k}");
        }
        assert!(s.contains("供需弹性原文样例"));
        assert!(s.contains("弹性vs斜率"));
    }
    #[test]
    fn feynman_system_varies_by_book_type() {
        let a = super::feynman_system(crate::models::BookType::Textbook, &ctx());
        let b = super::feynman_system(crate::models::BookType::Humanities, &ctx());
        assert!(a.contains("边界条件") && !b.contains("边界条件"));
        assert!(b.contains("因果"));
    }
    #[test]
    fn review_quiz_prompt_and_result_parse() {
        let s = super::review_quiz_prompt(&ctx());
        for k in ["快问", "薄弱点", "JSON"] {
            assert!(s.contains(k), "missing {k}");
        }
        let r = crate::eval::parse_quiz(r#"{"passed":true,"comment":"答出了要点"}"#).unwrap();
        assert!(r.passed && r.new_weak_point.is_none());
    }
    #[test]
    fn eval_prompt_demands_json_only() {
        let s = super::eval_prompt(&ctx(), "用户:...\n学生:...");
        for k in [
            "评估",
            "准确性",
            "完整性",
            "清晰度",
            "最后一条消息只输出 JSON",
            "fixed_in_session",
        ] {
            assert!(s.contains(k), "missing {k}");
        }
    }

    #[test]
    fn map_stage_a_prompt_asks_for_candidates_with_href_sections() {
        let s = super::map_stage_a_prompt(
            crate::models::BookType::Textbook,
            "ch03.xhtml",
            "第三章 弹性",
            "弹性原文……",
        );
        for k in [
            "知识点候选",
            "JSON 数组",
            "第三章 弹性",
            "ch03.xhtml#",
            "最后一条消息只输出 JSON",
        ] {
            assert!(s.contains(k), "missing {k}");
        }
        assert!(s.contains("弹性原文"));
    }
    #[test]
    fn map_stage_b_prompt_varies_by_book_type() {
        let a = super::map_stage_b_prompt(crate::models::BookType::Textbook, "[]");
        let b = super::map_stage_b_prompt(crate::models::BookType::Methodology, "[]");
        let c = super::map_stage_b_prompt(crate::models::BookType::Humanities, "[]");
        assert!(a.contains("前置依赖") && !b.contains("前置依赖"));
        assert!(b.contains("观点—框架—案例"));
        assert!(c.contains("叙事脉络"));
        for s in [&a, &b, &c] {
            for k in [
                "15–45 分钟",
                "source_sections",
                "#",
                "最后一条消息只输出 JSON",
            ] {
                assert!(s.contains(k), "missing {k}");
            }
        }
    }
    #[test]
    fn post_pass_prompts_contain_their_keywords() {
        use crate::extra::ExtraKind;
        let app = super::extra_system(ExtraKind::Application, &ctx());
        for k in ["现实情境", "禁止书内例题", "[READY_TO_END]", "供需弹性"] {
            assert!(app.contains(k), "application missing {k}");
        }
        assert!(!app.contains("JSON"));
        let m = super::extra_system(ExtraKind::Methodology, &ctx());
        for k in ["我的版本", "个人情境", "[READY_TO_END]"] {
            assert!(m.contains(k), "methodology missing {k}");
        }
        let h = super::extra_system(ExtraKind::Discussion, &ctx());
        for k in ["对立视角", "不评判立场", "[READY_TO_END]"] {
            assert!(h.contains(k), "humanities missing {k}");
        }
        let s = super::extra_summary_prompt(ExtraKind::Methodology, &ctx(), "用户:我的版本是……");
        for k in [
            "## 我的版本",
            "来源块为「供需弹性」",
            "用户:我的版本是……",
            "不要代码围栏",
        ] {
            assert!(s.contains(k), "summary missing {k}");
        }
        assert!(
            super::extra_summary_prompt(ExtraKind::Application, &ctx(), "").contains("## 掌握判断")
        );
        assert!(
            super::extra_summary_prompt(ExtraKind::Discussion, &ctx(), "")
                .contains("## 用到的史实")
        );
        let f = super::final_exam_prompt("| 供需弹性 | passed |");
        for k in [
            "全书框架",
            "学习报告",
            "供需弹性",
            "最后一条消息只输出 JSON",
        ] {
            assert!(f.contains(k), "final missing {k}");
        }
    }
}
