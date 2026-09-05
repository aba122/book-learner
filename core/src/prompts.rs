use crate::models::BookType;

/// 每次 AI 调用的固定注入上下文(TECH_DESIGN §3.2)。
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

/// 间隔复习快问 prompt(TECH_DESIGN §6.7)。
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

/// 6.4 迁移应用题(教材类,通过后)。prompt only:本计划无消费者。
pub fn application_prompt(ctx: &FixedContext) -> String {
    format!(
"基于本块知识与学习者画像中的个人情境,出 1–2 道现实情境应用题(禁止书内例题改编;优先贴近用户的工作/研究情境)。\
用户作答后,评估其思路是否正确运用了本块知识,指出运用错误或遗漏,给出简短评语与是否掌握迁移能力的判断。\n\n{}\n\n\
最后一条消息只输出 JSON:{{\"passed\":true|false,\"comment\":\"简短评语\"}}",
        context_block(ctx))
}

/// 6.5 情境化方法论引导(方法论类,通过后)。prompt only。
pub fn methodology_prompt(ctx: &FixedContext) -> String {
    format!(
"用户已掌握本块的观点/框架。请引导 2–3 轮:①问用户当下情境中哪个具体问题可以用它;②追问框架各要素如何映射到该问题;\
③请用户写出一段『我的版本』——结合情境改写后的个人方法论。最后把用户的『我的版本』整理为 markdown 片段(标注来源块)。\n\n{}\n\n\
最后一条消息只输出 JSON:{{\"markdown\":\"整理后的 markdown 片段\",\"source_block\":\"来源块标题\"}}",
        context_block(ctx))
}

/// 6.6 观点讨论(人文类,通过后)。prompt only。
pub fn humanities_discussion_prompt(ctx: &FixedContext) -> String {
    format!(
        "提出一个与本块叙事相关的对立视角或争议(史学争论、不同学派解读),邀请用户写下自己的看法;\
不评判立场,只评估其论证是否用到了本块史实。最后输出用户思考的整理稿(归档为思考笔记)。\n\n{}\n\n\
最后一条消息只输出 JSON:{{\"markdown\":\"整理稿\",\"used_facts\":true|false}}",
        context_block(ctx)
    )
}

/// 6.8 整书终评。prompt only。
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
        let app = super::application_prompt(&ctx());
        for k in [
            "现实情境",
            "禁止书内例题",
            "最后一条消息只输出 JSON",
            "passed",
        ] {
            assert!(app.contains(k), "application missing {k}");
        }
        let m = super::methodology_prompt(&ctx());
        for k in ["我的版本", "markdown", "最后一条消息只输出 JSON"] {
            assert!(m.contains(k), "methodology missing {k}");
        }
        let h = super::humanities_discussion_prompt(&ctx());
        for k in ["对立视角", "不评判立场", "最后一条消息只输出 JSON"] {
            assert!(h.contains(k), "humanities missing {k}");
        }
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
