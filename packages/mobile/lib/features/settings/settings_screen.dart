import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/format.dart';
import '../../core/http.dart';
import '../../core/models/device.dart';
import '../../core/nav.dart';
import '../../core/pairing.dart';
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
                onBack: () => back(context),
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
                        style: TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 10.5,
                          color: Octo.faint,
                        ),
                      )
                    else
                      for (final device in state.devices) ...[
                        _DeviceRow(
                          device: device,
                          current: device.id == state.currentDeviceId,
                          paired: state.tokenFor(device.id) != null,
                          onTap: () async {
                            await ref
                                .read(appStateProvider.notifier)
                                .selectDevice(device.id);
                            // 换掉「设置」这一页：下面垫着设备列表，返回回得去。
                            if (context.mounted) {
                              context.pushReplacement('/device');
                            }
                          },
                          onRename: () => _rename(context, ref, device),
                          onEditAddress: () =>
                              _editAddress(context, ref, device),
                          onPair: () => _pair(context, ref, device),
                          onClearToken: () => _clearToken(context, ref, device),
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
                      onChanged: (v) => ref
                          .read(appStateProvider.notifier)
                          .setReduceMotion(v),
                    ),
                    const SizedBox(height: 8),
                    _SwitchRow(
                      title: '立绘动画',
                      subtitle: '汐音的三支循环动作（透明 WebP 动画）；点立绘换下一支。关掉就不显示立绘',
                      value: state.crewVideo,
                      onChanged: (v) =>
                          ref.read(appStateProvider.notifier).setCrewVideo(v),
                    ),
                    const SizedBox(height: 22),
                    const SectionTitle('关于'),
                    const SizedBox(height: 10),
                    RoundedPanel(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Octopus · 手机端 M4',
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: Colors.white,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            '连的是你自己的 Tailscale 网络，不经过任何云端。\n'
                            '开了设备令牌的机器，第一次连接要用电脑「设置 → 手机配对」里的 6 位码换一条令牌；\n'
                            '配对同时会换一把受限 SSH 密钥 —— Octopus 没启动时，设备列表可以一键把它拉起来'
                            '（电脑得先跑过 scripts/remote/install-remote.ps1）。\n'
                            '令牌和私钥都只存在这台手机的系统安全存储里。\n'
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

  Future<void> _rename(
    BuildContext context,
    WidgetRef ref,
    Device device,
  ) async {
    final controller = TextEditingController(text: device.name);
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Octo.indigo2,
        title: const Text(
          '改个名字',
          style: TextStyle(fontSize: 15, color: Colors.white),
        ),
        content: TextField(
          controller: controller,
          autofocus: true,
          style: const TextStyle(fontSize: 13.5, color: Octo.ink),
          decoration: const InputDecoration(hintText: '设备名'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
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

  /// 改地址：换 IP / 域名 / 端口都行。令牌、远程拉起密钥、名字都留着 ——
  /// 只换根地址，改完立刻用新地址探一次，省得回列表才发现连不上。
  Future<void> _editAddress(
    BuildContext context,
    WidgetRef ref,
    Device device,
  ) async {
    final input = await showDialog<String>(
      context: context,
      builder: (_) =>
          _AddressDialog(name: device.name, initial: device.baseUrl),
    );
    if (input == null || input == device.baseUrl) return;

    await ref
        .read(appStateProvider.notifier)
        .setDeviceAddress(device.id, input);
    if (!context.mounted) return;

    // 后台探一次，直接说结果（探活自己 4 秒封顶，不会一直转）。
    final status = await ref.read(httpProbeProvider)(input);
    if (!context.mounted) return;
    final tail = switch (status) {
      DeviceStatus.running => '在线',
      DeviceStatus.notReady => '服务还没就绪',
      DeviceStatus.onlineStopped => '电脑在线，Octopus 没启动',
      DeviceStatus.offline => '暂时连不上 —— 手机和电脑要在一个网里',
      DeviceStatus.unknown => '状态未知',
    };
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('「${device.name}」→ $input · $tail'),
        duration: const Duration(seconds: 4),
      ),
    );
  }

  /// 配对：输入 6 位码（走兑换）或直接粘贴令牌（试一次 /api/cabins 再存）。
  Future<void> _pair(BuildContext context, WidgetRef ref, Device device) async {
    final controller = TextEditingController();
    final input = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Octo.indigo2,
        title: Text(
          '配对「${device.name}」',
          style: const TextStyle(fontSize: 15, color: Colors.white),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '在电脑「设置 → 手机配对」生成 6 位码（2 分钟内有效）。\n也可以直接粘贴设备令牌。',
              style: TextStyle(fontSize: 12, height: 1.6, color: Octo.ink2),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              autofocus: true,
              autocorrect: false,
              enableSuggestions: false,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 13,
                color: Octo.ink,
              ),
              decoration: const InputDecoration(hintText: '6 位配对码 / 设备令牌'),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('配对', style: TextStyle(color: Octo.teal)),
          ),
        ],
      ),
    );
    final value = (input ?? '').trim();
    controller.dispose();
    if (value.isEmpty) return;

    try {
      if (RegExp(r'^\d{6}$').hasMatch(value)) {
        final result = await redeemPairCode(
          device.baseUrl,
          value,
          name: device.name,
          platform: platformName(),
        );
        await ref
            .read(appStateProvider.notifier)
            .saveToken(device.id, result.token);
        if (result.hasRemote && result.sshUser != null) {
          await ref
              .read(appStateProvider.notifier)
              .saveRemote(
                device.id,
                user: result.sshUser!,
                port: result.sshPort ?? 22,
                slot: result.sshSlot,
                privateKey: result.sshKey,
              );
        }
        final hint = result.hasRemote ? null : result.remoteHint;
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                hint == null
                    ? '「${device.name}」已配对'
                    : '「${device.name}」已配对\n$hint',
              ),
              duration: Duration(seconds: hint == null ? 4 : 7),
            ),
          );
        }
      } else {
        final ok = await probeAuthorized(device.baseUrl, token: value);
        if (!ok) {
          throw ApiException('这条令牌无效 —— 在电脑上重新生成配对码', kind: 'unauthorized');
        }
        await ref.read(appStateProvider.notifier).saveToken(device.id, value);
        if (context.mounted) {
          ScaffoldMessenger.of(context)
              .showSnackBar(SnackBar(content: Text('「${device.name}」已配对')));
        }
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(describeError(e))));
      }
    }
  }

  Future<void> _clearToken(
    BuildContext context,
    WidgetRef ref,
    Device device,
  ) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Octo.indigo2,
        title: Text(
          '清除「${device.name}」的令牌？',
          style: const TextStyle(fontSize: 15, color: Colors.white),
        ),
        content: const Text(
          '清除后这台设备按「未配对」处理。如果电脑开了设备令牌，下一次请求会 401，'
          '需要重新配对。',
          style: TextStyle(fontSize: 12.5, color: Octo.ink2, height: 1.6),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('清除', style: TextStyle(color: Octo.red)),
          ),
        ],
      ),
    );
    if (ok == true) {
      await ref.read(appStateProvider.notifier).clearToken(device.id);
    }
  }

  Future<void> _delete(
    BuildContext context,
    WidgetRef ref,
    Device device,
  ) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Octo.indigo2,
        title: Text(
          '删掉「${device.name}」？',
          style: const TextStyle(fontSize: 15, color: Colors.white),
        ),
        content: const Text(
          '只删这台手机上的记录，电脑那边什么都不会变。',
          style: TextStyle(fontSize: 12.5, color: Octo.ink2, height: 1.6),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
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
    required this.paired,
    required this.onTap,
    required this.onRename,
    required this.onEditAddress,
    required this.onPair,
    required this.onClearToken,
    required this.onDelete,
  });

  final Device device;
  final bool current;
  final bool paired;
  final VoidCallback onTap;
  final VoidCallback onRename;
  final VoidCallback onEditAddress;
  final VoidCallback onPair;
  final VoidCallback onClearToken;
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
                        if (paired) ...[
                          const SizedBox(width: 8),
                          const StatusPill(label: '已配对', color: Octo.teal),
                        ],
                        if (device.hasRemote) ...[
                          const SizedBox(width: 8),
                          const StatusPill(label: '远程', color: Octo.teal),
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
                      device.lastSeenAt == null
                          ? '还没连过'
                          : '上次 ${formatAgo(device.lastSeenAt)}',
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
              if (value == 'address') onEditAddress();
              if (value == 'pair') onPair();
              if (value == 'clear') onClearToken();
              if (value == 'delete') onDelete();
            },
            itemBuilder: (ctx) => [
              const PopupMenuItem(
                value: 'rename',
                child: Text('重命名', style: TextStyle(fontSize: 13)),
              ),
              const PopupMenuItem(
                value: 'address',
                child: Text('改地址（IP / 域名）', style: TextStyle(fontSize: 13)),
              ),
              PopupMenuItem(
                value: 'pair',
                child: Text(
                  paired ? '换一条令牌' : '配对 / 粘贴令牌',
                  style: const TextStyle(fontSize: 13),
                ),
              ),
              if (paired)
                const PopupMenuItem(
                  value: 'clear',
                  child: Text('清除令牌', style: TextStyle(fontSize: 13)),
                ),
              const PopupMenuItem(
                value: 'delete',
                child: Text(
                  '删除',
                  style: TextStyle(fontSize: 13, color: Octo.red),
                ),
              ),
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

/// 改地址的小弹窗。自己拿输入框的 controller —— 弹窗退场动画里还会重建一帧，
/// 在外面 await 完就 dispose 会撞上「controller used after being disposed」。
class _AddressDialog extends StatefulWidget {
  const _AddressDialog({required this.name, required this.initial});

  final String name;
  final String initial;

  @override
  State<_AddressDialog> createState() => _AddressDialogState();
}

class _AddressDialogState extends State<_AddressDialog> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initial,
  );
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _save() {
    final next = normalizeBaseUrl(_controller.text);
    if (next.isEmpty) {
      setState(() => _error = '先填一个地址');
      return;
    }
    if ((Uri.tryParse(next)?.host ?? '').isEmpty) {
      setState(() => _error = '这个地址解析不出主机名');
      return;
    }
    Navigator.pop(context, next);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: Octo.indigo2,
      title: Text(
        '改「${widget.name}」的地址',
        style: const TextStyle(fontSize: 15, color: Colors.white),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            '换 IP、域名或端口都行；没写协议按 http 补。\n'
            '令牌和远程拉起密钥都留着，改完直接用新地址重连。',
            style: TextStyle(fontSize: 12, height: 1.6, color: Octo.ink2),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _controller,
            autofocus: true,
            autocorrect: false,
            enableSuggestions: false,
            keyboardType: TextInputType.url,
            style: const TextStyle(
              fontFamily: Octo.mono,
              fontSize: 12.5,
              color: Octo.ink,
            ),
            decoration: const InputDecoration(hintText: '192.168.2.168:3001'),
            onSubmitted: (_) => _save(),
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(
              _error!,
              style: const TextStyle(fontSize: 11.5, color: Octo.red),
            ),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('取消'),
        ),
        TextButton(
          onPressed: _save,
          child: const Text('保存', style: TextStyle(color: Octo.teal)),
        ),
      ],
    );
  }
}
