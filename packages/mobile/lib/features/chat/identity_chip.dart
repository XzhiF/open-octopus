import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../core/models/telemetry.dart';

/// 输入区上方的身份贴纸（原型 E5 / E）：`◉ 舱调度者`，点开星核·分身；
/// 右边再挂本轮的一次性委派与技能，✕ 直接摘掉。
class ChatIdentityChip extends StatelessWidget {
  const ChatIdentityChip({
    super.key,
    required this.role,
    this.skill,
    this.subagent,
    this.onTap,
    this.onClear,
    this.onSkillClear,
    this.onSubagentClear,
  });

  final SessionRole role;
  final String? skill;
  final ChatSubagentRef? subagent;
  final VoidCallback? onTap;

  /// 点 ✕ 回主身份（当前不是主 Agent 时才显示）。
  final VoidCallback? onClear;
  final VoidCallback? onSkillClear;
  final VoidCallback? onSubagentClear;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          _Pill(
            icon: '◉',
            label: role.label,
            fg: Octo.purple,
            border: Octo.purple.withValues(alpha: .45),
            bg: Octo.violet.withValues(alpha: .16),
            onTap: onTap,
            onClear: role.isMain ? null : onClear,
          ),
          if (subagent != null) ...[
            const SizedBox(width: 6),
            _Pill(
              icon: '⇢',
              label: '委派 ${subagent!.label}',
              fg: Octo.amber,
              border: Octo.amber.withValues(alpha: .4),
              bg: Octo.amber.withValues(alpha: .1),
              onClear: onSubagentClear,
            ),
          ],
          if (skill != null) ...[
            const SizedBox(width: 6),
            _Pill(
              icon: '⌘',
              label: '/$skill',
              fg: Octo.teal,
              border: Octo.teal.withValues(alpha: .38),
              bg: Octo.teal.withValues(alpha: .08),
              onClear: onSkillClear,
            ),
          ],
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({
    required this.icon,
    required this.label,
    required this.fg,
    required this.border,
    required this.bg,
    this.onTap,
    this.onClear,
  });

  final String icon;
  final String label;
  final Color fg;
  final Color border;
  final Color bg;
  final VoidCallback? onTap;
  final VoidCallback? onClear;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Container(
          height: 26,
          padding: EdgeInsets.only(left: 9, right: onClear == null ? 10 : 6),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: border),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(icon, style: TextStyle(fontSize: 10, height: 1, color: fg)),
              const SizedBox(width: 4),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 150),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 10,
                    height: 1,
                    fontWeight: FontWeight.w700,
                    letterSpacing: .2,
                    color: fg,
                  ),
                ),
              ),
              if (onClear != null)
                GestureDetector(
                  onTap: onClear,
                  behavior: HitTestBehavior.opaque,
                  child: Padding(
                    padding: const EdgeInsets.only(
                      left: 5,
                      top: 7,
                      bottom: 7,
                      right: 4,
                    ),
                    child: Text(
                      '✕',
                      style: TextStyle(
                        fontSize: 9,
                        height: 1,
                        color: fg.withValues(alpha: .8),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
