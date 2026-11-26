import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/http.dart';
import '../../core/models/device.dart';
import '../../core/providers.dart';
import '../../widgets/octo_bar.dart';
import '../../widgets/panel.dart';
import '../../widgets/scene_background.dart';

/// B · 添加设备：手填 Tailscale 域名（扫码配对随 M3 令牌一起做）。
class AddDeviceScreen extends ConsumerStatefulWidget {
  const AddDeviceScreen({super.key});

  @override
  ConsumerState<AddDeviceScreen> createState() => _AddDeviceScreenState();
}

class _AddDeviceScreenState extends ConsumerState<AddDeviceScreen> {
  final TextEditingController _url = TextEditingController();
  final TextEditingController _name = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    final baseUrl = normalizeBaseUrl(_url.text);
    if (baseUrl.isEmpty || !baseUrl.startsWith('http')) {
      setState(() => _error = '先填一个地址，例如 https://shufang-pc.tailxxxx.ts.net');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });

    final status = await probeDevice(baseUrl);
    if (!mounted) return;

    if (status == DeviceStatus.offline) {
      setState(() {
        _busy = false;
        _error = '连不上 $baseUrl\n'
            '检查三件事：电脑上 Octopus 开着 / 手机和电脑在同一个 Tailscale 网络 / 地址没写错';
      });
      return;
    }

    final name = _name.text.trim().isEmpty ? guessDeviceName(baseUrl) : _name.text.trim();
    final device = Device(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      name: name,
      baseUrl: baseUrl,
      platform: 'WINDOWS',
      lastSeenAt: DateTime.now().toIso8601String(),
    );
    await ref.read(appStateProvider.notifier).addDevice(device);
    await ref.read(appStateProvider.notifier).selectDevice(device.id);
    if (!mounted) return;
    context.go('/device');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Octo.screen,
      body: SceneBackground(
        asset: SceneBackground.deepspace,
        child: SafeArea(
          child: Column(
            children: [
              OctoBar(
                title: '添加设备',
                num: 'PAIRING',
                onBack: () => context.pop(),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                  children: [
                    const RoundedPanel(
                      padding: EdgeInsets.fromLTRB(14, 13, 14, 13),
                      child: Text(
                        '在电脑上打开 Octopus，确认它正在托盘里跑着。\n'
                        '地址就是这台电脑的 Tailscale 域名 —— 不经过任何云端。',
                        style: TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 10.5,
                          height: 1.75,
                          letterSpacing: .3,
                          color: Octo.dim,
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    const _ScanPlaceholder(),
                    const SizedBox(height: 18),
                    const SectionTitle('或者手动填'),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _url,
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      enableSuggestions: false,
                      style: const TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 11.5,
                        color: Octo.ink,
                      ),
                      decoration: const InputDecoration(
                        hintText: 'https://shufang-pc.tailxxxx.ts.net',
                      ),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _name,
                      style: const TextStyle(fontSize: 13, color: Octo.ink),
                      decoration: const InputDecoration(hintText: '名字（可留空，默认取域名第一段）'),
                    ),
                    if (kDebugMode) ...[
                      const SizedBox(height: 10),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          _DevChip(
                            label: '模拟器 → 10.0.2.2:3001',
                            onTap: () => _url.text = 'http://10.0.2.2:3001',
                          ),
                          _DevChip(
                            label: '本机 → 127.0.0.1:3001',
                            onTap: () => _url.text = 'http://127.0.0.1:3001',
                          ),
                        ],
                      ),
                    ],
                    if (_error != null) ...[
                      const SizedBox(height: 14),
                      RoundedPanel(
                        borderColor: Octo.red.withValues(alpha: .3),
                        child: Text(
                          _error!,
                          style: const TextStyle(
                            fontFamily: Octo.mono,
                            fontSize: 10.5,
                            height: 1.75,
                            color: Octo.red,
                          ),
                        ),
                      ),
                    ],
                    const SizedBox(height: 18),
                    PrimaryButton(label: '连 接', busy: _busy, onPressed: _connect),
                    const SizedBox(height: 12),
                    const Text(
                      '手机和电脑要在同一个 Tailscale 网络里',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 10,
                        height: 1.7,
                        color: Octo.faint,
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
}

class _ScanPlaceholder extends StatelessWidget {
  const _ScanPlaceholder();

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 170,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(Octo.rL),
        border: Border.all(color: Octo.teal.withValues(alpha: .3)),
        gradient: RadialGradient(
          colors: [Octo.teal.withValues(alpha: .08), Colors.transparent],
          stops: const [0, .7],
        ),
      ),
      child: const Center(
        child: Text(
          '扫码配对\n随 M3 的设备令牌一起做\n现在先手动填地址',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontFamily: Octo.mono,
            fontSize: 10,
            height: 1.8,
            letterSpacing: .4,
            color: Octo.faint,
          ),
        ),
      ),
    );
  }
}

class _DevChip extends StatelessWidget {
  const _DevChip({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: Octo.hairline),
          color: Colors.white.withValues(alpha: .04),
        ),
        child: Text(
          label,
          style: const TextStyle(
            fontFamily: Octo.mono,
            fontSize: 9.5,
            color: Octo.dim,
          ),
        ),
      ),
    );
  }
}
