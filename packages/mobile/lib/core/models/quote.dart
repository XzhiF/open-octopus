import 'cabin.dart';
import 'chat.dart';

/// 会话页顶部的引用上下文：从「待你定」点进来的那一问。
///
/// 纯前端状态（design 34 §3 / 35 §6）：不新增服务端字段，也不改消息内容；
/// 引用条只负责把问题原文与来源摆回人眼前，回复仍是正常发一条消息。
class SessionQuote {
  const SessionQuote({
    required this.attentionId,
    required this.stage,
    required this.question,
    required this.sourceName,
    required this.sourceLine,
    this.messageId,
  });

  final String attentionId;
  final AttentionStage stage;

  /// 问题原文（信封的「要定的事」优先）。
  final String question;

  /// 主体名：任务 / 委派 / 舱内事项，去掉服务端后缀。
  final String sourceName;

  /// `任务 · #1 · P2 · 第 2 轮`。
  final String sourceLine;

  /// 镜像卡 message.id —— 在同一条会话里数「依据 N 条」。
  final String? messageId;

  factory SessionQuote.fromAttention(AttentionItem item) => SessionQuote(
        attentionId: item.id,
        stage: item.stage,
        question: item.quoteText,
        sourceName: item.subjectName,
        sourceLine: item.sourceLine,
        messageId: item.ask?.messageId,
      );
}

/// 依据条数：镜像卡之前、同一条用户提问之内的工具行（`▸ Read … [✓]`）。
/// 快照里找不到那条消息（超出 limit / 还没加载完）时返回 null —— 不瞎猜。
int? countEvidence(List<ChatMessage> messages, String? messageId) {
  if (messageId == null || messageId.isEmpty) return null;
  final idx = messages.indexWhere((m) => m.id == messageId);
  if (idx < 0) return null;
  var count = 0;
  for (var i = idx - 1; i >= 0; i--) {
    final m = messages[i];
    if (m.isUser) break;
    final type = m.displayType;
    if (type == 'tool_call' || type == 'ask_user_question') count++;
  }
  return count;
}
