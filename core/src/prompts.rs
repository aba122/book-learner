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
        for k in ["快问", "薄弱点", "JSON"] { assert!(s.contains(k), "missing {k}"); }
        let r = crate::eval::parse_quiz(r#"{"passed":true,"comment":"答出了要点"}"#).unwrap();
        assert!(r.passed && r.new_weak_point.is_none());
    }
    #[test]
    fn eval_prompt_demands_json_only() {
        let s = super::eval_prompt(&ctx(), "用户:...\n学生:...");
        for k in ["评估", "准确性", "完整性", "清晰度", "最后一条消息只输出 JSON", "fixed_in_session"] {
            assert!(s.contains(k), "missing {k}");
        }
    }
}
