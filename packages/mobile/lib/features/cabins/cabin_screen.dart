import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/format.dart';
import '../../core/models/cabin.dart';
import '../../core/models/chat.dart';
import '../../core/models/task.dart';
import '../../core/providers.dart';
import '../../widgets/octo_bar.dart';
import '../../widgets/panel.dart';
import '../../widgets/scene_background.dart';
import '../../widgets/states.dart';

enum CabinTab { attention, sessions, tasks }

/// E · 舱内三块：待你定 / 会话 / 任务（任务只读）。
/// 硬规则：界面上不出现「改状态」的按钮 —— 点开回到会话，人用自然话说。
class CabinScreen extends ConsumerStatefulWidget {
  const CabinScreen({super.key, required this.cabinId});

  final String cabinId;

  @override
  ConsumerState<CabinScreen> createState() => _CabinScreenState();
}

class _CabinScreenState extends ConsumerState<CabinScreen> {
  CabinTab _tab = CabinTab.attention;

  @override
  Widget build(BuildContext context) {
    final detailAsync = ref.watch(cabinDetailProvider(widget.cabinId));
    final detail = detailAsync.value;
    final cabin = detail?.cabin;
    final workspaceId = cabin?.workspaceId;
    final device = ref.watch(currentDeviceProvider);

    final sessionsAsync = workspaceId == null ? null : ref.watch(sessionsProvider(workspaceId));
    final tasksAsync = ref.watch(cabinTasksProvider(widget.cabinId));

    final attention = detail?.attention ?? const <AttentionItem>[];
    final sessions = sessionsAsync?.value ?? const <SessionRef>[];
    final tasks = tasksAsync.value ?? const <TaskItem>[];

    return Scaffold(
      backgroundColor: Octo.screen,
      body: SceneBackground(
        asset: SceneBackground.deepspace,
        child: SafeArea(
          child: Column(
            children: [
              OctoBar(
                title: cabin?.name ?? '舱',
                num: 'CABIN',
                subtitle: [device?.name, _cabinStatus(cabin?.status)].whereType<String>().join(' · '),
                onBack: () => context.pop(),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              ),
              _Segmented(
                value: _tab,
                onChanged: (v) => setState(() => _tab = v),
                items: [
                  ('待你定', attention.length),
                  ('会话', sessions.length),
                  ('任务', tasks.length),
                ],
              ),
              Expanded(
                child: RefreshIndicator(
                  color: Octo.teal,
                  backgroundColor: Octo.indigo2,
                  onRefresh: () async {
                    ref.invalidate(cabinDetailProvider(widget.cabinId));
                    ref.invalidate(cabinTasksProvider(widget.cabinId));
                    if (workspaceId != null) ref.invalidate(sessionsProvider(workspaceId));
                    await Future<void>.delayed(const Duration(milliseconds: 500));
                  },
                  child: detailAsync.when(
                    loading: () => ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      children: const [SizedBox(height: 140), LoadingState()],
                    ),
                    error: (error, _) => ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      children: [
                        const SizedBox(height: 20),
                        ErrorState(
                          error: error,
                          onRetry: () => ref.invalidate(cabinDetailProvider(widget.cabinId)),
                        ),
                      ],
                    ),
                    data: (_) => switch (_tab) {
                      CabinTab.attention => _AttentionList(
                          cabin: cabin!,
                          items: attention,
                          workspaceId: workspaceId,
                        ),
                      CabinTab.sessions => _SessionsList(
                          workspaceId: workspaceId,
                          sessions: sessions,
                          loading: sessionsAsync?.isLoading ?? false,
                          error: sessionsAsync?.error,
                          onRetry: () {
                            if (workspaceId != null) ref.invalidate(sessionsProvider(workspaceId));
                          },
                          onOpen: (session) => context.push(
                            '/session/$workspaceId/${session.id}',
                          ),
                          onNew: workspaceId == null ? null : () => _createSession(workspaceId),
                        ),
                      CabinTab.tasks => _TasksList(
                          cabinId: widget.cabinId,
                          tasks: tasks,
                          loading: tasksAsync.isLoading,
                          error: tasksAsync.error,
                          onRetry: () => ref.invalidate(cabinTasksProvider(widget.cabinId)),
                        ),
                    },
                  ),
                ),
              ),
              RailLine(
                left: '⬡ ${cabin?.name ?? '舱'}',
                middle: switch (_tab) {
                  CabinTab.attention => '待你定 ${attention.length}',
                  CabinTab.sessions => '会话 ${sessions.length}',
                  CabinTab.tasks => '任务 ${tasks.length}',
                },
                right: 'OPEN ${detail?.health.running ?? 0}',
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _createSession(String workspaceId) async {
    final api = ref.read(apiProvider);
    if (api == null) return;
    try {
      final session = await api.createSession(workspaceId);
      if (!mounted) return;
      ref.invalidate(sessionsProvider(workspaceId));
      context.push('/session/$workspaceId/${session.id}');
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(describeError(e)), backgroundColor: Octo.red.withValues(alpha: .9)),
      );
    }
  }

  static String? _cabinStatus(String? status) => switch (status) {
        'active' => '运行中',
        'dormant' => '休眠',
        'archived' => '已归档',
        'initializing' => '初始化中',
        'draft' => '草稿',
        null => null,
        _ => status,
      };
}

class _Segmented extends StatelessWidget {
  const _Segmented({required this.value, required this.onChanged, required this.items});

  final CabinTab value;
  final ValueChanged<CabinTab> onChanged;

  /// (label, count)
  final List<(String, int)> items;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: const Color(0xA80A0818),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Octo.hairlineSoft),
      ),
      child: Row(
        children: [
          for (var i = 0; i < items.length; i++) ...[
            if (i > 0) const SizedBox(width: 4),
            Expanded(
              child: _SegItem(
                label: items[i].$1,
                count: items[i].$2,
                active: CabinTab.values[i] == value,
                onTap: () => onChanged(CabinTab.values[i]),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _SegItem extends StatelessWidget {
  const _SegItem({
    required this.label,
    required this.count,
    required this.active,
    required this.onTap,
  });

  final String label;
  final int count;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          gradient: active ? Octo.accentGradient : null,
        ),
        alignment: Alignment.center,
        child: Text.rich(
          TextSpan(
            children: [
              TextSpan(
                text: label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: active ? FontWeight.w700 : FontWeight.w600,
                  letterSpacing: .2,
                  color: active ? const Color(0xFF06131A) : Octo.dim,
                ),
              ),
              if (count > 0)
                TextSpan(
                  text: ' $count',
                  style: TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 9,
                    fontWeight: FontWeight.w800,
                    color: active ? const Color(0xFF06131A) : Octo.dim,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AttentionList extends StatelessWidget {
  const _AttentionList({
    required this.cabin,
    required this.items,
    required this.workspaceId,
  });

  final Cabin cabin;
  final List<AttentionItem> items;
  final String? workspaceId;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [
          SizedBox(height: 80),
          EmptyState(
            title: '这儿没有等你的事',
            detail: '有待你定 / 待验收的时候会出现在这里',
          ),
        ],
      );
    }
    final sorted = [...items]..sort((a, b) {
        if (a.stage.isReview != b.stage.isReview) return a.stage.isReview ? -1 : 1;
        return 0;
      });
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 16),
      children: [
        for (final item in sorted) ...[
          _AttentionCard(
            item: item,
            onTap: () {
              final sid = cabin.mainSessionId;
              if (sid == null || workspaceId == null) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('这个舱还没有主会话')),
                );
                return;
              }
              context.push('/session/$workspaceId/$sid');
            },
          ),
          const SizedBox(height: 10),
        ],
        const Padding(
          padding: EdgeInsets.fromLTRB(4, 4, 4, 0),
          child: Text(
            '点任意一条 = 回到会话，用人话说下一步',
            style: TextStyle(
              fontFamily: Octo.mono,
              fontSize: 10,
              height: 1.6,
              color: Octo.faint,
            ),
          ),
        ),
      ],
    );
  }
}

class _AttentionCard extends StatelessWidget {
  const _AttentionCard({required this.item, required this.onTap});

  final AttentionItem item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = item.stage.isReview ? Octo.pink : Octo.amber;
    final source = [
      item.source,
      item.handle,
      item.repo,
    ].whereType<String>().where((s) => s.isNotEmpty).join(' · ');

    return AccentPanel(
      accent: color,
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              StatusPill(label: item.stage.label, color: color),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  source.isEmpty ? '舱内事项' : source,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 9.5,
                    letterSpacing: .3,
                    color: Octo.dim,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            item.title,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              height: 1.5,
              color: Colors.white,
            ),
          ),
          if (item.question != null && item.question!.trim().isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              item.question!,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10.5,
                height: 1.65,
                color: Octo.ink2,
              ),
            ),
          ] else if (item.detail != null && item.detail!.trim().isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              item.detail!,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10.5,
                height: 1.65,
                color: Octo.dim,
              ),
            ),
          ],
          const SizedBox(height: 10),
          const Align(
            alignment: Alignment.centerRight,
            child: Text(
              '去会话里说 ›',
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: Octo.teal),
            ),
          ),
        ],
      ),
    );
  }
}

class _SessionsList extends StatelessWidget {
  const _SessionsList({
    required this.workspaceId,
    required this.sessions,
    required this.loading,
    required this.error,
    required this.onRetry,
    required this.onOpen,
    required this.onNew,
  });

  final String? workspaceId;
  final List<SessionRef> sessions;
  final bool loading;
  final Object? error;
  final VoidCallback onRetry;
  final ValueChanged<ChatSession> onOpen;
  final VoidCallback? onNew;

  @override
  Widget build(BuildContext context) {
    if (workspaceId == null) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [
          SizedBox(height: 80),
          EmptyState(
            title: '这个舱还没有绑定工作区',
            detail: '舱的会话挂在它的工作区上；先在电脑上初始化这个舱',
          ),
        ],
      );
    }
    if (loading && sessions.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [SizedBox(height: 120), LoadingState()],
      );
    }
    if (error != null && sessions.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [const SizedBox(height: 20), ErrorState(error: error!, onRetry: onRetry)],
      );
    }
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 16),
      children: [
        if (onNew != null) ...[
          GhostButton(label: '＋ 新建会话', onTap: onNew),
          const SizedBox(height: 12),
        ],
        if (sessions.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 26),
            child: EmptyState(
              title: '还没有会话',
              detail: '新建一个，说第一句话',
            ),
          )
        else
          for (final entry in sessions) ...[
            RoundedPanel(
              padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
              gradient: Octo.cardGradient,
              onTap: () => onOpen(entry.session),
              child: Row(
                children: [
                  Container(
                    width: 32,
                    height: 32,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(11),
                      border: Border.all(color: Octo.teal.withValues(alpha: .25)),
                      color: Octo.teal.withValues(alpha: .06),
                    ),
                    child: const Text(
                      '❯',
                      style: TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 13,
                        fontWeight: FontWeight.w800,
                        color: Octo.pink,
                      ),
                    ),
                  ),
                  const SizedBox(width: 11),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          entry.session.displayTitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                            color: Colors.white,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '${formatStamp(entry.session.updatedAt)} · ${entry.session.totalMessageCount} 条',
                          style: const TextStyle(
                            fontFamily: Octo.mono,
                            fontSize: 9.5,
                            color: Octo.dim,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const Icon(Icons.chevron_right, size: 17, color: Octo.metal2),
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],
      ],
    );
  }
}

class _TasksList extends StatelessWidget {
  const _TasksList({
    required this.cabinId,
    required this.tasks,
    required this.loading,
    required this.error,
    required this.onRetry,
  });

  final String cabinId;
  final List<TaskItem> tasks;
  final bool loading;
  final Object? error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    if (loading && tasks.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [SizedBox(height: 120), LoadingState()],
      );
    }
    if (error != null && tasks.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [const SizedBox(height: 20), ErrorState(error: error!, onRetry: onRetry)],
      );
    }
    if (tasks.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [
          SizedBox(height: 80),
          EmptyState(
            title: '这个舱里还没有任务',
            detail: '任务是在会话里谈出来的；手机端只读',
          ),
        ],
      );
    }
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 16),
      children: [
        for (final task in tasks) ...[
          RoundedPanel(
            padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
            gradient: Octo.cardGradient,
            onTap: () => context.push('/cabin/$cabinId/task/${task.id}'),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        task.name,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w600,
                          height: 1.4,
                          color: Colors.white,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '${taskStatusLabels[task.status] ?? task.status} · ${formatStamp(task.updatedAt)}',
                        style: const TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 9.5,
                          color: Octo.dim,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                StatusPill(
                  label: taskStatusLabels[task.status] ?? task.status,
                  color: _toneColor(task.status),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
        ],
        const Padding(
          padding: EdgeInsets.fromLTRB(4, 4, 4, 0),
          child: Text(
            '任务只读：触发 / 验收 / 归档都在电脑上',
            style: TextStyle(
              fontFamily: Octo.mono,
              fontSize: 10,
              height: 1.6,
              color: Octo.faint,
            ),
          ),
        ),
      ],
    );
  }

  static Color _toneColor(String status) => switch (taskTone(status)) {
        TaskTone.run => Octo.teal,
        TaskTone.wait => Octo.amber,
        TaskTone.review => Octo.pink,
        TaskTone.bad => Octo.red,
        TaskTone.neutral => Octo.metal2,
      };
}
