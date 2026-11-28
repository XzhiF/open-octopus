import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../../core/format.dart';
import '../../../core/models/telemetry.dart';
import 'sheet_shell.dart';

/// 上下文明细（原型 E8）：窗口占用 + 构成 + 直接压缩。
Future<void> showCtxSheet(
  BuildContext context, {
  required ContextUsage usage,
  required SessionUsage session,
  required VoidCallback onCompact,
  String? aliasModel,
}) {
  final pct = usage.clampedPercentage;
  final tone = _tone(pct);
  final effective = usage.model;
  final shown = [...usage.usedCategories]
    ..sort((a, b) => b.tokens.compareTo(a.tokens));
  final deferred = usage.categories
      .where((c) => c.isDeferred || c.kind == 'deferred')
      .toList(growable: false);

  return showOctoSheet<void>(
    context,
    title: '上下文',
    num: 'CTX',
    trailing:
        '${formatTokNum(usage.totalTokens)} / ${formatTokNum(usage.maxTokens)} · ${usage.estimated ? '~' : ''}${pct.toStringAsFixed(1)}%',
    builder: (ctx) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        SheetBar(value: pct / 100, tone: tone),
        const SizedBox(height: 4),
        for (final category in shown)
          SheetKv(
            label: _categoryLabel(category),
            value: formatTokNum(category.tokens),
          ),
        if (deferred.isNotEmpty) ...[
          const SheetSec('延后加载 · 不计入当前占用'),
          for (final category in deferred)
            SheetKv(
              label: _categoryLabel(category),
              value: '${formatTokNum(category.tokens)} · 延后',
              tone: Octo.faint,
            ),
        ],
        SheetKv(
          label: '缓存命中',
          value: formatRate(session.cacheHitRate),
          tone: Octo.green,
        ),
        SheetKv(
          label: '可用',
          value: formatTokNum(usage.availableTokens),
          tone: Octo.teal,
        ),
        if (effective != null && effective.isNotEmpty)
          SheetKv(
            label: '实际运行模型',
            value: aliasModel != null && aliasModel != effective
                ? '$effective（别名 $aliasModel）'
                : effective,
          ),
        if (usage.estimated)
          const SheetFoot('这一份是账本估算（provider 还没在本进程上报）—— 下一轮对话会用真实数字校准。')
        else
          const SheetFoot('数字来自 SDK context_usage；估算值前面带 ~。60% 起转琥珀，85% 转红。'),
        const SizedBox(height: 6),
        SheetRow(
          icon: '⚡',
          title: '现在压一下',
          description: '保留关键事实，丢冗余（/compact）',
          onTap: () {
            Navigator.of(ctx).pop();
            onCompact();
          },
          trailing: const SheetPill(label: '压缩'),
        ),
      ],
    ),
  );
}

Color _tone(double pct) {
  if (pct >= 85) return Octo.red;
  if (pct >= 60) return Octo.amber;
  return Octo.teal;
}

/// SDK 的类别名是英文；手机翻译成原型里的中文（未知类别原样显示）。
String _categoryLabel(ContextCategory category) {
  return switch (category.id) {
    'system_prompt' => '系统提示',
    'system_tools' => '工具定义',
    'mcp_tools' => 'MCP 工具',
    'mcp_instructions' => 'MCP 说明',
    'custom_agents' => '分身',
    'memory_files' => '记忆文件',
    'skills' => '技能',
    'messages' => '消息',
    'autocompact_buffer' => '自动压缩预留',
    'system_tools_deferred' => '延后工具定义',
    _ => category.name,
  };
}
