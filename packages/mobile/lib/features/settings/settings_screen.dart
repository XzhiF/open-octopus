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

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(appStateProvider);

    return Scaffold(
      backgroundColor: Octo.screen,
      body: SceneBackground(
        asset: SceneBackground.cruise,
        child: SafeArea(
          child: Column(
            children: [
              OctoBar(
                title: '设置',
                num: 'SYS',
                onBack: () => context.pop(),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 2, 16, 24),
                  children: [
                    const SectionTitle('设备'),
                    const SizedBox(height: 10),
                    if (state.devices.isEmpty)
                      const Text(
                        '还没有设备 —— 回设备列表加一台',
                        style: TextStyle(fontFamily: Octo.mono, fontSize: 10.5, color: Octo.faint),
                      )
                    else
                      for (final device in state.devices) ...[
                        _DeviceRow(
                          device: device,
                          current: device.id == state.currentDeviceId,
                          onTap: () async {
                            await ref.read(appStateProvider.notifier).selectDevice(device.id);
                            if (context.mounted) context.go('/device');
                          },
                          onRename: () => _rename(context, ref, device),
                          onDelete: () => _delete(context, ref, device),
                        ),
                        const SizedBox(height: 8),
                      ],
                    const SizedBox(height: 8),
                    GhostButton(
                      label: '＋ 添加设备',
                      onTap: () => context.push('/add-device'),
                    ),
                    const SizedBox(height: 22),
                    const SectionTitle('显示'),
                    const SizedBox(height: 10),
                    _SwitchRow(
                      title: '减少动效',
                      subtitle: '星流定格、场景图停止呼吸缩放',
                      value: state.reduceMotion,
                      onChanged: (v) => ref.read(appStateProvider.notifier).setReduceMotion(v),
                    ),
                    const SizedBox(height: 8),
                    _SwitchRow(
                      title: '立绘用视频（实验）',
                      subtitle: '全舱模式那 13 支 VP9 透明立绘；能不能真透明取决于机型的解码器',
                      value: state.crewVideo,
                      onChanged: (v) => ref.read(appStateProvider.notifier).setCrewVideo(v),
                    ),
                    const SizedBox(height: 22),
                    const SectionTitle('关于'),
                    const SizedBox(height: 10),
                    RoundedPanel(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Octopus · 手机端 M1',
                            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Colors.white),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            '连的是你自己的 Tailscale 网络，不经过任何云端。\n'
                            '手机端只做两件事：进某个舱，或者开一个不归属任何舱的单独会话。\n'
                            '状态由 agent 改 —— 界面上没有「改状态」的按钮。',
                            style: TextStyle(
                              fontFamily: Octo.mono,
                              fontSize: 10,
                              height: 1.8,
                              color: Octo.dim.withValues(alpha: .95),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _rename(BuildContext context, WidgetRef ref, Device device) async {
    final controller = TextEditingController(text: device.name);
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Octo.indigo2,
        title: const Text('改个名字', style: TextStyle(fontSize: 15, color: Colors.white)),
        content: TextField(
          controller: controller,
          autofocus: true,
          style: const TextStyle(fontSize: 13.5, color: Octo.ink),
          decoration: const InputDecoration(hintText: '设备名'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('保存', style: TextStyle(color: Octo.teal)),
          ),
        ],
      ),
    );
    if (name != null && name.isNotEmpty) {
      await ref.read(appStateProvider.notifier).renameDevice(device.id, name);
    }
    controller.dispose();
  }

  Future<void> _delete(BuildContext context, WidgetRef ref, Device device) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Octo.indigo2,
        title: Text('删掉「${device.name}」？',
            style: const TextStyle(fontSize: 15, color: Colors.white)),
        content: const Text(
          '只删这台手机上的记录，电脑那边什么都不会变。',
          style: TextStyle(fontSize: 12.5, color: Octo.ink2, height: 1.6),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('删除', style: TextStyle(color: Octo.red)),
          ),
        ],
      ),
    );
    if (ok == true) {
      await ref.read(appStateProvider.notifier).removeDevice(device.id);
    }
  }
}

class _DeviceRow extends StatelessWidget {
  const _DeviceRow({
    required this.device,
    required this.current,
    required this.onTap,
    required this.onRename,
    required this.onDelete,
  });

  final Device device;
  final bool current;
  final VoidCallback onTap;
  final VoidCallback onRename;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    return RoundedPanel(
      padding: const EdgeInsets.fromLTRB(14, 10, 6, 10),
      borderColor: current ? Octo.teal.withValues(alpha: .35) : null,
      gradient: Octo.cardGradient,
      child: Row(
        children: [
          Expanded(
            child: InkWell(
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Text(
                          device.name,
                          style: const TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                            color: Colors.white,
                          ),
                        ),
                        if (current) ...[
                          const SizedBox(width: 8),
                          const StatusPill(label: '当前', color: Octo.teal),
                        ],
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      device.baseUrl,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 9.5,
                        color: Octo.dim,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      device.lastSeenAt == null ? '还没连过' : '上次 ${formatAgo(device.lastSeenAt)}',
                      style: const TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 9,
                        color: Octo.faint,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          PopupMenuButton<String>(
            color: Octo.indigo2,
            icon: const Icon(Icons.more_vert, size: 17, color: Octo.metal2),
            onSelected: (value) {
              if (value == 'rename') onRename();
              if (value == 'delete') onDelete();
            },
            itemBuilder: (ctx) => const [
              PopupMenuItem(value: 'rename', child: Text('重命名', style: TextStyle(fontSize: 13))),
              PopupMenuItem(value: 'delete', child: Text('删除', style: TextStyle(fontSize: 13, color: Octo.red))),
            ],
          ),
        ],
      ),
    );
  }
}

class _SwitchRow extends StatelessWidget {
  const _SwitchRow({
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
  });

  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return RoundedPanel(
      padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  subtitle,
                  style: const TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 9.5,
                    height: 1.6,
                    color: Octo.dim,
                  ),
                ),
              ],
            ),
          ),
          Switch(
            value: value,
            onChanged: onChanged,
            thumbColor: WidgetStateProperty.resolveWith(
              (states) => states.contains(WidgetState.selected)
                  ? const Color(0xFF06131A)
                  : Octo.metal2,
            ),
            trackColor: WidgetStateProperty.resolveWith(
              (states) => states.contains(WidgetState.selected)
                  ? Octo.teal
                  : const Color(0x33100D28),
            ),
          ),
        ],
      ),
    );
  }
}
