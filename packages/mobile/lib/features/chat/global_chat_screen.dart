import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/format.dart';
import '../../core/models/chat.dart';
import '../../core/nav.dart';
import '../../core/providers.dart';
import '../../widgets/octo_bar.dart';
import '../../widgets/panel.dart';
import '../../widgets/scene_background.dart';
import '../../widgets/states.dart';

/// H · 单独会话：不进舱、不建任务，问完就走。
/// 走 `/api/chat/global/sessions`（服务端挂在 scheduler 作用域下）。
class GlobalChatScreen extends ConsumerStatefulWidget {
  const GlobalChatScreen({super.key});

  @override
  ConsumerState<GlobalChatScreen> createState() => _GlobalChatScreenState();
}

class _GlobalChatScreenState extends ConsumerState<GlobalChatScreen> {
  bool _creating = false;

  Future<void> _newSession() async {
    final api = ref.read(apiProvider);
    if (api == null || _creating) return;
    setState(() => _creating = true);
    try {
      final session = await api.createSession(null);
      if (!mounted) return;
      ref.invalidate(globalSessionsProvider);
      context.push('/global/${session.id}');
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(describeError(e)), backgroundColor: Octo.red.withValues(alpha: .9)),
      );
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final device = ref.watch(currentDeviceProvider);
    final sessionsAsync = ref.watch(globalSessionsProvider);

    return Scaffold(
      backgroundColor: Octo.screen,
      body: SceneBackground(
        asset: SceneBackground.cruise,
        child: SafeArea(
          child: Column(
            children: [
              OctoBar(
                title: '单独会话',
                num: 'FREE',
                subtitle: device == null ? null : '${device.name} · 不归属任何舱',
                onBack: () => back(context),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              ),
              Expanded(
                child: RefreshIndicator(
                  color: Octo.teal,
                  backgroundColor: Octo.indigo2,
                  onRefresh: () async {
                    ref.invalidate(globalSessionsProvider);
                    await Future<void>.delayed(const Duration(milliseconds: 500));
                  },
                  child: sessionsAsync.when(
                    loading: () => ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      children: const [SizedBox(height: 120), LoadingState()],
                    ),
                    error: (error, _) => ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      children: [
                        const SizedBox(height: 20),
                        ErrorState(
                          error: error,
                          onRetry: () => ref.invalidate(globalSessionsProvider),
                        ),
                      ],
                    ),
                    data: (sessions) => ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: const EdgeInsets.fromLTRB(16, 2, 16, 16),
                      children: [
                        PrimaryButton(
                          label: _creating ? '正在建…' : '＋ 新建单独会话',
                          busy: _creating,
                          onPressed: _creating ? null : _newSession,
                        ),
                        const SizedBox(height: 16),
                        SectionTitle('最近 · ${sessions.length}'),
                        const SizedBox(height: 10),
                        if (sessions.isEmpty)
                          const Padding(
                            padding: EdgeInsets.symmetric(vertical: 40),
                            child: EmptyState(
                              title: '还没有单独会话',
                              detail: '问完就走的一次性对话\n不写进任何舱',
                            ),
                          )
                        else
                          for (final entry in sessions) ...[
                            _SessionRow(
                              session: entry.session,
                              onTap: () => context.push('/global/${entry.session.id}'),
                            ),
                            const SizedBox(height: 10),
                          ],
                      ],
                    ),
                  ),
                ),
              ),
              RailLine(
                left: '⬡ ${device?.name ?? '设备'}',
                middle: 'FREE CHAT',
                right: '${sessionsAsync.value?.length ?? 0} THREADS',
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({required this.session, required this.onTap});

  final ChatSession session;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return RoundedPanel(
      padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
      gradient: Octo.cardGradient,
      onTap: onTap,
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
              '✳',
              style: TextStyle(fontSize: 14, color: Octo.teal),
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  session.displayTitle,
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
                  '${formatStamp(session.updatedAt)} · ${session.totalMessageCount} 条',
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
    );
  }
}
