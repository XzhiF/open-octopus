import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../../core/format.dart';
import '../../../core/models/telemetry.dart';
import 'sheet_shell.dart';

/// 本会话 TOKEN（原型 E9）：账本聚合 + 按模型拆。
///
/// 数据来自 `llm_calls`（聚合由服务端 `taskUsage` 晚绑定给同一本账），
/// 缓存命中率是「复用率」，和 ctx 占用不是一回事。
Future<void> showTokSheet(
  BuildContext context, {
  required SessionUsage usage,
  VoidCallback? onCabinLedger,
}) {
  final tokens = formatTokNum(usage.tokens);
  final cost = formatCny(usage.costUsd, complete: usage.costComplete);
  return showOctoSheet<void>(
    context,
    title: '本会话 TOKEN',
    num: 'TOK',
    trailing: '$tokens tok · $cost',
    builder: (ctx) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        SheetKv(label: '调用', value: '${usage.totalCalls} 次'),
        SheetKv(
          label: 'tokens',
          value:
              '$tokens（入 ${formatTokNum(usage.usage.inputTokens)} · 出 ${formatTokNum(usage.usage.outputTokens)}）',
          tone: Octo.ink,
        ),
        SheetKv(
          label: '缓存命中',
          value: formatRate(usage.cacheHitRate),
          tone: Octo.green,
        ),
        SheetKv(label: '费用', value: cost, tone: Octo.gold),
        if (usage.models.isNotEmpty) ...[
          const SheetSec('按模型'),
          for (final model in usage.models)
            SheetRow(
              icon: '◆',
              title: model.model,
              description:
                  '${model.calls} 次 · 入 ${formatTokNum(model.usage.inputTokens)} · 出 ${formatTokNum(model.usage.outputTokens)}',
              trailing: Text(
                formatCny(model.costUsd),
                style: const TextStyle(
                  fontFamily: Octo.mono,
                  fontSize: 9.5,
                  color: Octo.gold,
                ),
              ),
            ),
        ],
        if (onCabinLedger != null)
          SheetRow(
            icon: '▤',
            title: '本舱账本',
            description: '全域累计 · 只读（任务 / 会话分开记）',
            onTap: () {
              Navigator.of(ctx).pop();
              onCabinLedger();
            },
            trailing: const SheetPill(
              label: '去看看 ›',
              tone: SheetPillTone.ghost,
            ),
          ),
        const SheetFoot(
          '本会话账来自 llm_calls；缓存命中率是复用率，和 ctx 占用不是一回事。未定价的模型费用显示「—」。',
        ),
      ],
    ),
  );
}

/// 本舱全域账本（tok 抽屉底部的只读入口）。
Future<void> showCabinLedgerSheet(
  BuildContext context, {
  required SessionUsage usage,
  String? cabinName,
}) {
  return showOctoSheet<void>(
    context,
    title: '本舱账本',
    num: 'LEDGER',
    trailing: cabinName == null ? '全域累计 · 只读' : '$cabinName · 只读',
    builder: (ctx) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        SheetKv(label: '调用', value: '${usage.totalCalls} 次'),
        SheetKv(
          label: 'tokens',
          value: formatTokNum(usage.tokens),
          tone: Octo.ink,
        ),
        SheetKv(
          label: '缓存命中',
          value: formatRate(usage.cacheHitRate),
          tone: Octo.green,
        ),
        SheetKv(
          label: '费用',
          value: formatCny(usage.costUsd, complete: usage.costComplete),
          tone: Octo.gold,
        ),
        if (usage.models.isNotEmpty) ...[
          const SheetSec('按模型'),
          for (final model in usage.models)
            SheetKv(
              label: model.model,
              value:
                  '${model.calls} 次 · ${formatTokNum(model.usage.total)} tok',
            ),
        ],
        const SheetFoot('舱账本包含任务轮、委派与主对话直接跑的工作流，是全域累计；任务 / 会话分开记。'),
      ],
    ),
  );
}
