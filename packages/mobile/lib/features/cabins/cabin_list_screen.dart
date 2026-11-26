import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/format.dart';
import '../../core/models/device.dart';
import '../../core/providers.dart';
import '../../widgets/octo_bar.dart';
import '../../widgets/panel.dart';
import '../../widgets/scene_background.dart';
import '../../widgets/states.dart';

/// D · 舱列表：顶部点机器名回设备列表换机器；角标是「等你动手的条数」。
class CabinListScreen extends ConsumerWidget {
  const CabinListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final device = ref.watch(currentDeviceProvider);
    if (device == null) {
      return Scaffold(
        backgroundColor: Octo.screen,
        body: SceneBackground(
          asset: SceneBackground.cruise,
          child: SafeArea(
            child: Center(
              child: EmptyState(
                title: '还没选设备',
                detail: '先回设备列表挑一台机器',
                action: PrimaryButton(
                  label: '回设备列表',
                  onPressed: () => context.go('/'),
                ),
              ),
            ),
          ),
        ),
      );
    }

    final statusAsync = ref.watch(deviceStatusProvider(device.id));
    final status = statusAsync.value ?? DeviceStatus.unknown;
    final cabinsAsync = ref.watch(cabinsProvider);

    return Scaffold(
      backgroundColor: Octo.screen,
      body: SceneBackground(
        asset: SceneBackground.cruise,
        child: SafeArea(
          child: Column(
            children: [
              OctoBar(
                title: device.name,
                num: _statusNum(status),
                subtitle: _statusLabel(status),
                onBack: () {
                  ref.read(appStateProvider.notifier).selectDevice(null);
                  context.go('/');
                },
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                actions: [
                  BarIconButton(
                    onTap: () => context.push('/settings'),
                    child: const Icon(Icons.more_horiz, size: 18, color: Octo.metal2),
                  ),
                ],
              ),
              Expanded(
                child: RefreshIndicator(
                  color: Octo.teal,
                  backgroundColor: Octo.indigo2,
                  onRefresh: () async {
                    ref.invalidate(deviceStatusProvider(device.id));
                    ref.invalidate(cabinsProvider);
                    await Future<void>.delayed(const Duration(milliseconds: 500));
                  },
                  child: cabinsAsync.when(
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
                          onRetry: () => ref.invalidate(cabinsProvider),
                        ),
                      ],
                    ),
                    data: (cabins) => ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: const EdgeInsets.fromLTRB(16, 2, 16, 16),
                      children: [
                        _NewSessionCard(onTap: () => context.push('/chat')),
                        const SizedBox(height: 16),
                        SectionTitle('作业舱 · ${cabins.length}'),
                        const SizedBox(height: 10),
                        if (cabins.isEmpty)
                          const Padding(
                            padding: EdgeInsets.symmetric(vertical: 30),
                            child: EmptyState(
                              title: '这台机器上还没有舱',
                              detail: '舱是在电脑上建的：一个目录一个舱',
                            ),
                          )
                        else
                          for (final card in cabins) ...[
                            _CabinRow(card: card),
                            const SizedBox(height: 10),
                          ],
                      ],
                    ),
                  ),
                ),
              ),
              RailLine(
                left: '⬡ ${device.name}',
                middle: _statusLabel(status),
                right: 'DECK ${cabinsAsync.value?.length ?? 0}',
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _statusLabel(DeviceStatus s) => switch (s) {
        DeviceStatus.running => '运行中',
        DeviceStatus.notReady => '在线 · 未就绪',
        DeviceStatus.offline => '离线',
        DeviceStatus.unknown => '检测中',
      };

  static String _statusNum(DeviceStatus s) => switch (s) {
        DeviceStatus.running => 'LINK OK',
        DeviceStatus.notReady => 'LINK WARN',
        DeviceStatus.offline => 'LINK LOST',
        DeviceStatus.unknown => 'LINK …',
      };
}

class _NewSessionCard extends StatelessWidget {
  const _NewSessionCard({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return RoundedPanel(
      padding: const EdgeInsets.all(14),
      borderColor: Octo.teal.withValues(alpha: .3),
      gradient: const LinearGradient(
        begin: Alignment.centerLeft,
        end: Alignment.centerRight,
        colors: [Color(0x262EE6D6), Color(0x217B4DFF)],
      ),
      onTap: onTap,
      child: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              gradient: Octo.accentGradient,
            ),
            child: const Text(
              '＋',
              style: TextStyle(fontSize: 18, height: 1, color: Color(0xFF06131A)),
            ),
          ),
          const SizedBox(width: 12),
          const Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '新建单独会话',
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Colors.white),
                ),
                SizedBox(height: 4),
                Text(
                  '不归属任何舱的一次性对话',
                  style: TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 10,
                    letterSpacing: .3,
                    color: Octo.dim,
                  ),
                ),
              ],
            ),
          ),
          const Icon(Icons.chevron_right, size: 18, color: Octo.teal),
        ],
      ),
    );
  }
}

class _CabinRow extends StatelessWidget {
  const _CabinRow({required this.card});

  final CabinCard card;

  @override
  Widget build(BuildContext context) {
    final cabin = card.cabin;
    Widget? badge;
    if (card.reviewCount > 0) {
      badge = StatusPill(label: '待验收 ${card.reviewCount}', color: Octo.pink);
    } else if (card.waitCount > 0) {
      badge = StatusPill(label: '待你定 ${card.waitCount}', color: Octo.amber);
    } else if (card.runningCount > 0) {
      badge = StatusPill(label: '进行中 ${card.runningCount}', color: Octo.teal);
    }

    return RoundedPanel(
      padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
      gradient: Octo.cardGradient,
      onTap: () => context.push('/cabin/${cabin.id}'),
      child: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(11),
              border: Border.all(color: Octo.teal.withValues(alpha: .3)),
              gradient: const LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [Color(0x242EE6D6), Color(0x297B4DFF)],
              ),
            ),
            child: const Icon(Icons.home_outlined, size: 16, color: Octo.teal),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  cabin.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  pathTail(cabin.path),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 10,
                    height: 1.5,
                    color: Octo.dim,
                  ),
                ),
              ],
            ),
          ),
          if (badge != null) ...[const SizedBox(width: 8), badge],
        ],
      ),
    );
  }
}
