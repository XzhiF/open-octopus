import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/format.dart';
import '../../core/haptics.dart';
import '../../core/models/device.dart';
import '../../core/providers.dart';
import '../../widgets/crew_animation.dart';
import '../../widgets/octo_bar.dart';
import '../../widgets/panel.dart';
import '../../widgets/scene_background.dart';

/// A · 设备列表：一台电脑一张卡，状态一眼可见。
class DevicesScreen extends ConsumerWidget {
  const DevicesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(appStateProvider);
    final devices = state.devices;

    return Scaffold(
      backgroundColor: Octo.screen,
      body: SceneBackground(
        asset: SceneBackground.cruise,
        child: SafeArea(
          child: Column(
            children: [
              OctoBar(
                title: 'Octopus',
                num: 'LINK ${devices.length.toString().padLeft(2, '0')}',
                subtitle: devices.isEmpty ? '还没有设备 · 先加一台' : '${devices.length} 台设备 · TAILNET',
                leading: const CrewAvatar(size: 36),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                actions: [
                  BarIconButton(
                    primaryStyle: true,
                    onTap: () => context.push('/add-device'),
                    child: const Text(
                      '＋ 添加',
                      style: TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1,
                        color: Octo.teal,
                      ),
                    ),
                  ),
                  BarIconButton(
                    onTap: () => context.push('/settings'),
                    child: const Icon(Icons.tune, size: 16, color: Octo.metal2),
                  ),
                ],
              ),
              Expanded(
                child: devices.isEmpty
                    ? _EmptyDevices(
                        onAdd: () => context.push('/add-device'),
                        animated: ref.watch(crewVideoProvider),
                      )
                    : RefreshIndicator(
                        color: Octo.teal,
                        backgroundColor: Octo.indigo2,
                        onRefresh: () async {
                          for (final d in devices) {
                            ref.invalidate(deviceStatusProvider(d.id));
                          }
                          await Future<void>.delayed(const Duration(milliseconds: 600));
                        },
                        child: ListView(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: const EdgeInsets.fromLTRB(16, 2, 16, 16),
                          children: [
                            const SectionTitle('设备'),
                            const SizedBox(height: 10),
                            for (final device in devices) ...[
                              _DeviceTile(device: device),
                              const SizedBox(height: 10),
                            ],
                            const SizedBox(height: 2),
                            GhostButton(
                              label: '＋ 添加设备',
                              onTap: () => context.push('/add-device'),
                            ),
                            const SizedBox(height: 18),
                            CrewStage(
                              height: 250,
                              animated: ref.watch(crewVideoProvider),
                            ),
                          ],
                        ),
                      ),
              ),
              RailLine(
                left: '⬡ TAILNET',
                middle: '已连接',
                right: 'SYNC ${_nowStamp()}',
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _nowStamp() {
    final now = DateTime.now();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${two(now.hour)}:${two(now.minute)}';
  }
}

class _EmptyDevices extends StatelessWidget {
  const _EmptyDevices({required this.onAdd, this.animated = true});

  final VoidCallback onAdd;
  final bool animated;

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      children: [
        const SizedBox(height: 30),
        // 与舱内同一个动画立绘；「立绘动画」关掉时这里同样不画。
        CrewFigure(height: 240, alignment: Alignment.center, cycleOnTap: false, animated: animated),
        const SizedBox(height: 4),
        const Text(
          '先把家里那台机器加进来',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: Colors.white),
        ),
        const SizedBox(height: 10),
        const Text(
          '地址就是它的 Tailscale 域名\n手机和电脑要在同一个 tailnet 里',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontFamily: Octo.mono,
            fontSize: 11,
            height: 1.8,
            color: Octo.dim,
          ),
        ),
        const SizedBox(height: 22),
        PrimaryButton(label: '连接一台机器', onPressed: onAdd),
      ],
    );
  }
}

class _DeviceTile extends ConsumerWidget {
  const _DeviceTile({required this.device});

  final Device device;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final statusAsync = ref.watch(deviceStatusProvider(device.id));
    final launch = ref.watch(deviceLaunchProvider.select((m) => m[device.id]));
    final status = statusAsync.value ?? DeviceStatus.unknown;

    final launching = launch?.starting == true;
    final launchFailed = launch?.phase == LaunchPhase.failed;
    final onlineStopped = status == DeviceStatus.onlineStopped;
    final canStart = onlineStopped || launchFailed;

    final color = switch (status) {
      DeviceStatus.running => Octo.green,
      DeviceStatus.notReady => Octo.amber,
      DeviceStatus.onlineStopped => Octo.teal,
      DeviceStatus.offline => Octo.off,
      DeviceStatus.unknown => Octo.off,
    };
    final pillLabel = launching
        ? '启动中'
        : switch (status) {
            DeviceStatus.running => '运行中',
            DeviceStatus.notReady => '在线·未就绪',
            DeviceStatus.onlineStopped => '在线·未启动',
            DeviceStatus.offline => '离线',
            DeviceStatus.unknown => '检测中',
          };

    final platform = (device.platform ?? _guessPlatform(device.baseUrl)).toUpperCase();
    final lastSeen = device.lastSeenAt;
    final baseSub = lastSeen == null
        ? '$platform · ${shortenPath(device.baseUrl, max: 34)}'
        : '$platform · 上次 ${formatAgo(lastSeen)}';
    final sub = launching
        ? '正在拉起 Octopus… 最多等 90 秒'
        : launchFailed
            ? (launch?.message ?? '启动失败')
            : onlineStopped
                ? '电脑在线，Octopus 没启动 —— 点「启动」把它叫起来'
                : baseSub;

    void start() => ref.read(deviceLaunchProvider.notifier).start(device.id);

    return Opacity(
      opacity: status == DeviceStatus.offline && !launchFailed ? .82 : 1,
      child: RoundedPanel(
        padding: const EdgeInsets.fromLTRB(15, 14, 15, 14),
        borderColor: launching || onlineStopped
            ? Octo.teal.withValues(alpha: .28)
            : launchFailed
                ? Octo.red.withValues(alpha: .32)
                : status == DeviceStatus.running
                    ? Octo.green.withValues(alpha: .24)
                    : status == DeviceStatus.notReady
                        ? Octo.amber.withValues(alpha: .26)
                        : Octo.hairline,
        gradient: Octo.cardGradient,
        onTap: () async {
          if (onlineStopped && !launching) {
            start();
            return;
          }
          await ref.read(appStateProvider.notifier).selectDevice(device.id);
          // push：进舱列表后系统返回 / 边缘左滑能退回设备列表，而不是把 App 退掉。
          if (context.mounted) context.push('/device');
        },
        child: Row(
          children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: color,
                shape: BoxShape.circle,
                boxShadow: [BoxShadow(color: color, blurRadius: 10)],
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    device.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w600,
                      color: Colors.white,
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    sub,
                    maxLines: launchFailed ? 2 : 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: Octo.mono,
                      fontSize: 10.5,
                      height: 1.5,
                      letterSpacing: .3,
                      color: launchFailed ? Octo.red : Octo.dim,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            StatusPill(label: pillLabel, color: launching ? Octo.teal : color),
            const SizedBox(width: 6),
            if (launching)
              const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Octo.teal,
                ),
              )
            else if (canStart)
              _StartButton(label: launchFailed ? '重试' : '启动', onTap: start)
            else
              const Icon(Icons.chevron_right, size: 18, color: Octo.metal2),
          ],
        ),
      ),
    );
  }

  static String _guessPlatform(String baseUrl) {
    final host = Uri.tryParse(baseUrl)?.host ?? '';
    if (host.contains('mac') || host.contains('macbook')) return 'macos';
    return 'windows';
  }
}

/// 设备行右侧的小药丸按钮：「启动 / 重试」。
class _StartButton extends StatelessWidget {
  const _StartButton({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () {
        Haptics.tap();
        onTap();
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: Octo.teal.withValues(alpha: .5)),
          color: Octo.teal.withValues(alpha: .12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.play_arrow, size: 13, color: Octo.teal),
            const SizedBox(width: 3),
            Text(
              label,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10,
                fontWeight: FontWeight.w700,
                letterSpacing: .5,
                color: Octo.teal,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
