import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../../core/format.dart';
import 'sheet_shell.dart';

/// 一轮真人发言（通讯台「≡ 轮次」抽屉里的一条）。
class TurnEntry {
  const TurnEntry({
    required this.id,
    required this.index,
    required this.text,
    required this.createdAt,
  });

  final String id;

  /// 从 1 开始的轮次号（按消息顺序）。
  final int index;
  final String text;
  final String createdAt;
}

/// 轮次索引（原型 E3）：一条 = 你的一句话，新的在上。
///
/// 返回值是用户点选的那条用户消息 id；调用方收起抽屉后把消息滚到那一行并闪一下。
Future<String?> showTurnsSheet(
  BuildContext context, {
  required List<TurnEntry> turns,
}) {
  final ordered = [...turns]..sort((a, b) => b.index.compareTo(a.index));
  final currentIndex = turns.isEmpty ? 0 : turns.last.index;

  return showOctoSheet<String>(
    context,
    title: '轮次',
    num: 'TURNS',
    trailing: '${turns.length} 轮 · 新的在上',
    maxHeightFactor: .78,
    builder: (ctx) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final turn in ordered)
          Padding(
            padding: const EdgeInsets.only(bottom: 5),
            child: _TurnRow(
              turn: turn,
              current: turn.index == currentIndex,
              onTap: () => Navigator.of(ctx).pop(turn.id),
            ),
          ),
        const SheetFoot('点一条 = 抽屉收起，消息滚到那一行并闪一下（粉）。当前轮青色，跳转目标粉色。'),
      ],
    ),
  );
}

class _TurnRow extends StatelessWidget {
  const _TurnRow({
    required this.turn,
    required this.current,
    required this.onTap,
  });

  final TurnEntry turn;
  final bool current;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border(
              left: BorderSide(
                color: current ? Octo.teal : Colors.transparent,
                width: 2,
              ),
            ),
            color: current
                ? Octo.teal.withValues(alpha: .07)
                : Colors.white.withValues(alpha: .025),
          ),
          child: Row(
            children: [
              SizedBox(
                width: 26,
                child: Text(
                  '${turn.index}',
                  style: TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                    color: current ? Octo.teal : Octo.metal2,
                  ),
                ),
              ),
              Expanded(
                child: Text(
                  turn.text.replaceAll(RegExp(r'\s+'), ' ').trim(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 10.5,
                    height: 1.5,
                    color: current ? Colors.white : Octo.metal,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                formatAgoShort(turn.createdAt),
                style: const TextStyle(
                  fontFamily: Octo.mono,
                  fontSize: 9,
                  color: Octo.dim,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
