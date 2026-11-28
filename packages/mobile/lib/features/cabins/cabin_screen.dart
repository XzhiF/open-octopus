import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/models/cabin.dart';
import '../../core/models/device.dart';
import '../../core/models/quote.dart';
import '../../core/providers.dart';
import '../../widgets/link_banner.dart';
import '../../widgets/octo_bar.dart';
import '../../widgets/panel.dart';
import '../../widgets/scene_background.dart';
import '../../widgets/states.dart';
import '../chat/chat_pane.dart';

/// E · 舱内主 chat：点进舱直接落到这 —— 跟汐音说话，她站在聊天面板后侧动着，
/// 消息列满宽不打折。待你定 / 会话 / 任务走右上角「☰ 编队」。
///
/// 主会话定位：`cabins.main_session_id` 优先；列表回来发现它不在了
/// （归档 / 清库）就退回最新一条；一条都没有就让人先建一个。
class CabinScreen extends ConsumerStatefulWidget {
  const CabinScreen({super.key, required this.cabinId});

  final String cabinId;

  @override
  ConsumerState<CabinScreen> createState() => _CabinScreenState();
}

class _CabinScreenState extends ConsumerState<CabinScreen>
    with WidgetsBindingObserver {
  /// 从「☰ 编队」的待你定里点回来时，问题挂到输入框上方（原型 E2 → E）。
  SessionQuote? _quote;

  Timer? _refreshDebounce;
  bool _creating = false;

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
    ref.invalidate(cabinTasksProvider(widget.cabinId));
    ref.invalidate(cabinSessionsProvider(widget.cabinId));
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
        : (ref.watch(deviceStatusProvider(device.id)).value ??
              DeviceStatus.unknown);

    // 舱事件：attention / 状态一变就重拉快照（见 providers.cabinEventsProvider）。
    ref.listen(cabinEventsProvider(widget.cabinId), (_, next) {
      final event = next.value;
      if (event == null) return;
      if (event.event == 'cabin_view' || event.event == 'cabin_status') {
        _scheduleRefresh();
      }
    });

    final sessionsAsync = ref.watch(cabinSessionsProvider(widget.cabinId));
    final sessions = sessionsAsync.value;

    // 主会话以 `cabins.main_session_id` 为准 —— 它不在 agent 会话列表里
    // （列表故意排除舱主会话），不能因为「列表里没见到」就当成没有。
    // 主会话 id 空时才退回列表第一条。
    String? sessionId = cabin?.mainSessionId;
    if (sessionId == null && sessions != null && sessions.isNotEmpty) {
      sessionId = sessions.first.session.id;
    }

    return Scaffold(
      backgroundColor: Octo.screen,
      resizeToAvoidBottomInset: true,
      body: SceneBackground(
        asset: SceneBackground.deepspace,
        child: SafeArea(
          child: Column(
            children: [
              OctoBar(
                title: cabin?.name ?? '舱',
                num: '主 CHAT',
                subtitle: [
                  device?.name,
                  _cabinStatus(cabin?.status),
                ].whereType<String>().join(' · '),
                onBack: () => context.pop(),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                actions: [
                  BarIconButton(
                    primaryStyle: true,
                    onTap: cabin == null ? null : _openFleet,
                    child: const Text(
                      '☰ 编队',
                      style: TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1,
                        color: Octo.teal,
                      ),
                    ),
                  ),
                ],
              ),
              LinkBanner(
                status: status,
                onRetry: () {
                  if (device != null)
                    ref.invalidate(deviceStatusProvider(device.id));
                  _refreshNow();
                },
              ),
              Expanded(
                child: _buildBody(
                  detailAsync: detailAsync,
                  cabin: cabin,
                  workspaceId: workspaceId,
                  sessions: sessions,
                  sessionId: sessionId,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildBody({
    required AsyncValue<CabinDetail> detailAsync,
    required Cabin? cabin,
    required String? workspaceId,
    required List<SessionRef>? sessions,
    required String? sessionId,
  }) {
    if (detailAsync.isLoading && cabin == null) {
      return const LoadingState(label: '正在连这个舱…');
    }
    if (detailAsync.error != null && cabin == null) {
      return Center(
        child: ErrorState(
          error: detailAsync.error!,
          onRetry: () => ref.invalidate(cabinDetailProvider(widget.cabinId)),
        ),
      );
    }
    if (cabin == null) {
      return const Center(
        child: EmptyState(title: '找不到这个舱', detail: '它可能被归档或删掉了，回舱列表看看'),
      );
    }
    if (workspaceId == null) {
      return const Center(
        child: EmptyState(
          title: '这个舱还没有绑定工作区',
          detail: '舱的会话挂在它的工作区上；先在电脑上初始化这个舱',
        ),
      );
    }
    if (sessionId == null && sessions == null) {
      return const LoadingState(label: '正在找主会话…');
    }
    if (sessionId == null) {
      return Center(
        child: EmptyState(
          title: '这个舱还没有会话',
          detail: '建一个，说第一句话',
          action: PrimaryButton(
            label: '新建会话',
            busy: _creating,
            onPressed: _creating ? null : () => _createSession(workspaceId),
          ),
        ),
      );
    }
    return ChatPane(
      key: ValueKey(sessionId),
      workspaceId: workspaceId,
      sessionId: sessionId,
      cabinId: widget.cabinId,
      cabinName: cabin.name,
      agent: true,
      quote: _quote,
      onQuoteClosed: () => setState(() => _quote = null),
      crewBehind: true,
      fleetHint: true,
    );
  }

  Future<void> _openFleet() async {
    final quote = await context.push<SessionQuote>(
      '/cabin/${widget.cabinId}/fleet',
    );
    if (!mounted) return;
    if (quote != null) setState(() => _quote = quote);
    _refreshNow();
  }

  Future<void> _createSession(String workspaceId) async {
    final api = ref.read(apiProvider);
    if (api == null || _creating) return;
    setState(() => _creating = true);
    try {
      final session = await api.createAgentSession(workspaceId);
      await api.registerCabinSession(widget.cabinId, session.id);
      if (!mounted) return;
      ref.invalidate(cabinSessionsProvider(widget.cabinId));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(describeError(e)),
          backgroundColor: Octo.red.withValues(alpha: .9),
        ),
      );
    } finally {
      if (mounted) setState(() => _creating = false);
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
