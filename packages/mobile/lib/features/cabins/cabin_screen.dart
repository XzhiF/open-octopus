import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/format.dart';
import '../../core/models/cabin.dart';
import '../../core/models/chat.dart';
import '../../core/models/device.dart';
import '../../core/models/quote.dart';
import '../../core/models/task.dart';
import '../../core/providers.dart';
import '../../widgets/octo_bar.dart';
import '../../widgets/panel.dart';
import '../../widgets/scene_background.dart';
import '../../widgets/states.dart';

enum CabinTab { attention, sessions, tasks }

/// E · 舱内三块：待你定 / 会话 / 任务（任务只读）。
/// 硬规则：界面上不出现「改状态」的按钮 —— 点开回到会话，人用自然话说。
/// 状态变化靠 `cabins/:id/events`（cabin_view）+ 快照刷新，不轮询。
class CabinScreen extends ConsumerStatefulWidget {
  const CabinScreen({super.key, required this.cabinId});

  final String cabinId;

  @override
  ConsumerState<CabinScreen> createState() => _CabinScreenState();
}

class _CabinScreenState extends ConsumerState<CabinScreen>
    with WidgetsBindingObserver {
  CabinTab _tab = CabinTab.attention;
  Timer? _refreshDebounce;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _refreshDebounce?.cancel();
    super.dispose();
  }

  /// 切后台断流后回来：先拉一次快照（SSE 在后台可能被系统掐掉）。
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refreshNow();
  }

  /// 服务端会连发几条 cabin_view（提问 / 决策 / 委派各自一次），合并成一次拉取。
  void _scheduleRefresh() {
    _refreshDebounce?.cancel();
    _refreshDebounce = Timer(const Duration(milliseconds: 450), _refreshNow);
  }

  void _refreshNow() {
    if (!mounted) return;
    ref.invalidate(cabinDetailProvider(widget.cabinId));
  }

  @override
  Widget build(BuildContext context) {
    final detailAsync = ref.watch(cabinDetailProvider(widget.cabinId));
    final detail = detailAsync.value;
    final cabin = detail?.cabin;
    final workspaceId = cabin?.workspaceId;
    final device = ref.watch(currentDeviceProvider);
    final status = device == null
        ? DeviceStatus.unknown
        : (ref.watch(deviceStatusProvider(device.id)).value ?? DeviceStatus.unknown);

    // 舱事件：attention / 状态一变就重拉快照（见 providers.cabinEventsProvider）。
    ref.listen(cabinEventsProvider(widget.cabinId), (_, next) {
      final event = next.value;
      if (event == null) return;
      if (event.event == 'cabin_view' || event.event == 'cabin_status') {
        _scheduleRefresh();
      }
    });

    final sessionsAsync = workspaceId == null ? null : ref.watch(sessionsProvider(workspaceId));
    final tasksAsync = ref.watch(cabinTasksProvider(widget.cabinId));

    final attention = detail?.attentionList ?? const <AttentionItem>[];
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
              _LinkBanner(
                status: status,
                onRetry: () {
                  if (device != null) ref.invalidate(deviceStatusProvider(device.id));
                  _refreshNow();
                },
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
                    if (device != null) ref.invalidate(deviceStatusProvider(device.id));
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
                          items: attention,
                          onOpen: cabin == null
                              ? null
                              : (item) => _openAttention(
                                    cabin,
                                    item,
                                    sessions,
                                    sessionsAsync?.value != null,
                                  ),
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

  /// 点「待你定」= 回到舱主会话，带上这一问的引用；回来再拉一次快照。
  ///
  /// 会话定位：优先舱主会话；主会话已不在列表里（被归档 / 清库）就退回最新一条。
  /// 一条会话都没有时不硬闯，给个「去会话页」的口子让人先建。
  Future<void> _openAttention(
    Cabin cabin,
    AttentionItem item,
    List<SessionRef> sessions,
    bool sessionsReady,
  ) async {
    var sessionId = cabin.mainSessionId;
    if (sessionsReady) {
      final mainListed = sessionId != null && sessions.any((s) => s.session.id == sessionId);
      if (!mainListed) sessionId = sessions.isEmpty ? null : sessions.first.session.id;
    }
    final workspaceId = cabin.workspaceId;
    if (sessionId == null || workspaceId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text('这个舱还没有会话 —— 建一个，说第一句话'),
          action: SnackBarAction(
            label: '去会话页',
            onPressed: () {
              if (mounted) setState(() => _tab = CabinTab.sessions);
            },
          ),
        ),
      );
      return;
    }
    final quote = SessionQuote.fromAttention(item);
    await context.push('/session/$workspaceId/$sessionId', extra: quote);
    if (!mounted) return;
    _refreshNow();
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

/// 链路状态条：离线 / 未就绪时压一条，别让人对着转圈猜。
class _LinkBanner extends StatelessWidget {
  const _LinkBanner({required this.status, this.onRetry});

  final DeviceStatus status;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final Color color;
    final String text;
    switch (status) {
      case DeviceStatus.offline:
        color = Octo.red;
        text = '离线：电脑没开 / 不在同一 Tailscale 网络';
      case DeviceStatus.onlineStopped:
        color = Octo.teal;
        text = '电脑在线，但 Octopus 没启动 —— 回设备列表点「启动」';
      case DeviceStatus.notReady:
        color = Octo.amber;
        text = '在线 · 未就绪：服务起来了，还在准备';
      case DeviceStatus.running:
      case DeviceStatus.unknown:
        return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
      child: RoundedPanel(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        borderColor: color.withValues(alpha: .32),
        gradient: LinearGradient(
          begin: Alignment.centerLeft,
          end: Alignment.centerRight,
          colors: [color.withValues(alpha: .1), const Color(0x990E0B22)],
        ),
        child: Row(
          children: [
            Icon(
              status == DeviceStatus.offline
                  ? Icons.cloud_off
                  : status == DeviceStatus.onlineStopped
                      ? Icons.power_settings_new
                      : Icons.hourglass_empty,
              size: 14,
              color: color,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontFamily: Octo.mono,
                  fontSize: 10,
                  color: Octo.dim,
                ),
              ),
            ),
            if (onRetry != null)
              TextButton(
                onPressed: onRetry,
                style: TextButton.styleFrom(
                  foregroundColor: color,
                  minimumSize: const Size(0, 30),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(999),
                    side: BorderSide(color: color.withValues(alpha: .35)),
                  ),
                ),
                child: const Text('重试', style: TextStyle(fontSize: 10.5)),
              ),
          ],
        ),
      ),
    );
  }
}

class _AttentionList extends StatelessWidget {
  const _AttentionList({required this.items, this.onOpen});

  final List<AttentionItem> items;
  final ValueChanged<AttentionItem>? onOpen;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [
          SizedBox(height: 80),
          EmptyState(
            title: '这儿没有等你的事',
            detail: '有待你定 / 待验收的时候会出现在这里\n状态由 agent 改，你只管说话',
          ),
        ],
      );
    }
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 16),
      children: [
        for (final item in items) ...[
          _AttentionCard(
            item: item,
            onTap: onOpen == null ? null : () => onOpen!(item),
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
  const _AttentionCard({required this.item, this.onTap});

  final AttentionItem item;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final color = switch (item.stage) {
      AttentionStage.review => Octo.pink,
      AttentionStage.blocked => Octo.red,
      AttentionStage.notice => Octo.teal,
      _ => Octo.amber,
    };
    final body = item.quoteText;
    final showBody = body.trim().isNotEmpty && body.trim() != item.subjectName.trim();

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
                  item.sourceLine,
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
            item.subjectName,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              height: 1.5,
              color: Colors.white,
            ),
          ),
          if (showBody) ...[
            const SizedBox(height: 6),
            Text(
              body,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10.5,
                height: 1.65,
                color: Octo.ink2,
              ),
            ),
          ],
          if (onTap != null) ...[
            const SizedBox(height: 10),
            const Align(
              alignment: Alignment.centerRight,
              child: Text(
                '去会话里说 ›',
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: Octo.teal),
              ),
            ),
          ],
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
