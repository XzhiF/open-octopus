import 'dart:convert';

/// `AskUserQuestion` 的选项 / 问题模型与作答格式。
///
/// 数据来自 agent 消息 metadata 的 `questions`（快照）或工具入参的
/// `questions`（流式兜底）。提交正文与桌面 `ask-user-question-card.tsx`
/// 保持同一份口径 —— 服务端按这段文本继续推理。
class AskOption {
  const AskOption({required this.label, this.description = ''});

  final String label;
  final String description;

  factory AskOption.fromJson(Map<String, dynamic> json) => AskOption(
    label: (json['label'] as String?)?.trim() ?? '',
    description: (json['description'] as String?)?.trim() ?? '',
  );
}

class AskQuestion {
  const AskQuestion({
    required this.question,
    this.header = '',
    this.multiSelect = false,
    this.options = const [],
  });

  final String question;
  final String header;
  final bool multiSelect;
  final List<AskOption> options;

  factory AskQuestion.fromJson(Map<String, dynamic> json) {
    final rawOptions = json['options'];
    return AskQuestion(
      question: (json['question'] as String?)?.trim() ?? '',
      header: (json['header'] as String?)?.trim() ?? '',
      multiSelect: json['multiSelect'] == true,
      options: rawOptions is List
          ? rawOptions
                .whereType<Map>()
                .map((e) => AskOption.fromJson(e.cast<String, dynamic>()))
                .where((o) => o.label.isNotEmpty)
                .toList(growable: false)
          : const [],
    );
  }
}

/// 宽容读：List / `{questions: […]}` / JSON 字符串 / 单个问题对象。
List<AskQuestion> parseAskQuestions(Object? raw) {
  Object? value = raw;
  if (value is String) {
    try {
      value = jsonDecode(value);
    } catch (_) {
      return const [];
    }
  }
  if (value is Map) {
    final questions = value['questions'];
    if (questions is List)
      value = questions;
    else if (value.containsKey('question'))
      value = [value];
    else
      return const [];
  }
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map((e) => AskQuestion.fromJson(e.cast<String, dynamic>()))
      .where((q) => q.question.isNotEmpty)
      .toList(growable: false);
}

const _otherLabels = {'其他', '其它', 'other', '自定义'};

bool isOtherOption(AskOption option) => isOtherLabel(option.label);

bool isOtherLabel(String label) =>
    _otherLabels.contains(label.trim().toLowerCase());

/// 「其他」在选项里的显示名（保留工具给的原文，没有就用「其他」）。
String otherLabelOf(AskQuestion question) {
  for (final option in question.options) {
    if (isOtherLabel(option.label)) return option.label;
  }
  return '其他';
}

List<AskOption> normalOptionsOf(AskQuestion question) => question.options
    .where((o) => !isOtherLabel(o.label))
    .toList(growable: false);

/// 一道题当前是否已作答；单选返回一个 label（多选可能多个，用 Set 承载）。
String? answerFor(
  AskQuestion question,
  Set<String> selected,
  String otherText,
) {
  final otherLabel = otherLabelOf(question);
  final other = otherText.trim();
  if (question.multiSelect) {
    final labels = selected.where((v) => v != otherLabel).toList();
    final parts = [...labels, if (other.isNotEmpty) other];
    return parts.isEmpty ? null : parts.join(', ');
  }
  if (selected.isEmpty) return null;
  if (selected.first == otherLabel) return other.isEmpty ? null : other;
  return selected.first;
}

/// 提交正文（与桌面 `formatAnswerContent` 同构）。
String formatAskAnswer(
  List<AskQuestion> questions,
  Map<int, Set<String>> selected,
  Map<int, String> otherTexts,
) {
  final lines = <String>['用户回答了以下问题：', ''];
  for (var i = 0; i < questions.length; i++) {
    final q = questions[i];
    final value = answerFor(
      q,
      selected[i] ?? const <String>{},
      otherTexts[i] ?? '',
    );
    if (value == null) continue;
    lines.add('${i + 1}. [${q.header}] ${q.question}');
    lines.add('   → $value');
    lines.add('');
  }
  return lines.join('\n').trimRight();
}

/// 「先讨论」正文（与桌面 `formatChatAboutContent` 同构）。
String formatAskChatAbout(
  List<AskQuestion> questions,
  Map<int, Set<String>> selected,
  Map<int, String> otherTexts,
) {
  final lines = <String>[
    '用户想先讨论这些问题，而不是直接作答。',
    '用户可能有额外的信息、上下文或问题要问你。',
    '请结合用户的说明，必要时重新提问；先问用户想澄清什么。',
    '',
    '已问的问题：',
  ];
  for (var i = 0; i < questions.length; i++) {
    final q = questions[i];
    final value = answerFor(
      q,
      selected[i] ?? const <String>{},
      otherTexts[i] ?? '',
    );
    lines.add('- “${q.question}”');
    lines.add('  当前答案：${value ?? '（未回答）'}');
    final other = (otherTexts[i] ?? '').trim();
    if (other.isNotEmpty) lines.add('  用户补充：$other');
  }
  return lines.join('\n');
}

/// 转录里的回答消息 → 一行摘要（`一起清掉；证据截图`）。
/// 不是这两种回答消息时返回 null。
String? askAnswerSummary(String text) {
  final body = text.trimLeft();
  if (body.startsWith('用户回答了以下问题')) {
    final values = <String>[];
    for (final line in text.split('\n')) {
      final part = line.trimLeft();
      if (part.startsWith('→')) {
        final value = part.substring(1).trim();
        if (value.isNotEmpty) values.add(value);
      }
    }
    return values.isEmpty ? '已回答' : values.join('；');
  }
  if (body.startsWith('用户想先讨论')) return '先讨论';
  return null;
}
