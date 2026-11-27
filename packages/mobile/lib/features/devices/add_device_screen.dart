import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/haptics.dart';
import '../../core/http.dart';
import '../../core/models/device.dart';
import '../../core/pairing.dart';
import '../../core/providers.dart';
import '../../widgets/octo_bar.dart';
import '../../widgets/panel.dart';
import '../../widgets/scene_background.dart';

/// B · 添加设备：手填 Tailscale 域名；这台机器开了设备令牌时，用配对码换令牌。
///
/// 流程：探活（免鉴权的 /health）→ 试 `/api/cabins` 看要不要令牌 →
/// 需要就展开配对卡（6 位码 / 直接粘贴令牌）→ 兑换成功后才存设备。
class AddDeviceScreen extends ConsumerStatefulWidget {
  const AddDeviceScreen({super.key});

  @override
  ConsumerState<AddDeviceScreen> createState() => _AddDeviceScreenState();
}

class _AddDeviceScreenState extends ConsumerState<AddDeviceScreen> {
  final TextEditingController _url = TextEditingController();
  final TextEditingController _name = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final TextEditingController _token = TextEditingController();
  bool _busy = false;
  bool _needsPairing = false;
  String? _error;
  String? _pairError;

  @override
  void dispose() {
    _url.dispose();
    _name.dispose();
    _code.dispose();
    _token.dispose();
    super.dispose();
  }

  String get _baseUrl => normalizeBaseUrl(_url.text);

  bool _validateUrl() {
    if (_baseUrl.isEmpty || !_baseUrl.startsWith('http')) {
      setState(() => _error = '先填一个地址，例如 https://shufang-pc.tailxxxx.ts.net');
      return false;
    }
    return true;
  }

  /// 探活 → 试鉴权 → 通了直接进；不通展开配对卡。
  Future<void> _connect() async {
    if (!_validateUrl()) return;
    setState(() {
      _busy = true;
      _error = null;
      _pairError = null;
    });

    final baseUrl = _baseUrl;
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

    final pasted = _token.text.trim();
    try {
      final ok = await probeAuthorized(baseUrl, token: pasted.isEmpty ? null : pasted);
      if (!mounted) return;
      if (!ok) {
        setState(() {
          _busy = false;
          _needsPairing = true;
          _pairError = pasted.isEmpty ? null : '粘贴的令牌无效 —— 用配对码重新换一条';
        });
        return;
      }
      await _finishConnect(baseUrl, token: pasted.isEmpty ? null : pasted);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.message;
      });
    } catch (e) {
      // 安全存储写失败 / 其它平台异常：别把「配好了」当成真的。
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = describeError(e);
      });
    }
  }

  /// 用 6 位码换长期令牌（或者直接粘贴令牌），换到才落设备。
  Future<void> _pairAndConnect() async {
    if (!_validateUrl()) return;
    final code = _code.text.trim();
    final pasted = _token.text.trim();
    if (code.isEmpty && pasted.isEmpty) {
      setState(() => _pairError = '配对码是 6 位数字 —— 在电脑「设置 → 手机配对」生成；也可以直接粘贴令牌');
      return;
    }
    setState(() {
      _busy = true;
      _pairError = null;
      _error = null;
    });
    final baseUrl = _baseUrl;
    try {
      if (code.isEmpty) {
        // 只粘贴了令牌：先试一次再存。
        final ok = await probeAuthorized(baseUrl, token: pasted);
        if (!ok) {
          throw ApiException('这条令牌无效 —— 在电脑上重新生成配对码', kind: 'unauthorized');
        }
        if (!mounted) return;
        await _finishConnect(baseUrl, token: pasted);
        return;
      }
      final result = await redeemPairCode(
        baseUrl,
        code,
        name: _name.text.trim().isEmpty ? null : _name.text.trim(),
        platform: platformName(),
      );
      if (!mounted) return;
      await _finishConnect(baseUrl, token: result.token, fallbackName: result.name, pair: result);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _pairError = e.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _pairError = describeError(e);
      });
    }
  }

  Future<void> _finishConnect(
    String baseUrl, {
    String? token,
    String? fallbackName,
    PairResult? pair,
  }) async {
    final rawName = _name.text.trim();
    final name = rawName.isNotEmpty
        ? rawName
        : (fallbackName != null && fallbackName.trim().isNotEmpty
            ? fallbackName.trim()
            : guessDeviceName(baseUrl));
    final device = Device(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      name: name,
      baseUrl: baseUrl,
      platform: platformName().toUpperCase(),
      lastSeenAt: DateTime.now().toIso8601String(),
      sshUser: pair?.sshUser,
      sshPort: pair?.sshPort,
      sshSlot: pair?.sshSlot,
    );
    await ref.read(appStateProvider.notifier).addDevice(device);
    if (token != null && token.isNotEmpty) {
      await ref.read(appStateProvider.notifier).saveToken(device.id, token);
    }
    if (pair != null && pair.hasRemote && pair.sshUser != null) {
      await ref.read(appStateProvider.notifier).saveRemote(
            device.id,
            user: pair.sshUser!,
            port: pair.sshPort ?? 22,
            slot: pair.sshSlot,
            privateKey: pair.sshKey,
          );
    }
    await ref.read(appStateProvider.notifier).selectDevice(device.id);
    if (!mounted) return;
    Haptics.ok();
    final hint = pair?.hasRemote == true ? null : pair?.remoteHint;
    if (hint != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(hint), duration: const Duration(seconds: 7)),
      );
    }
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
                        '地址就是这台电脑的 Tailscale 域名 —— 不经过任何云端。\n'
                        '开了设备令牌的话，第一句话会换成一句「需要配对码」。',
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
                    if (!_needsPairing) ...[
                      const SizedBox(height: 10),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton(
                          onPressed: () => setState(() => _needsPairing = true),
                          style: TextButton.styleFrom(
                            foregroundColor: Octo.teal,
                            padding: EdgeInsets.zero,
                            minimumSize: const Size(0, 32),
                          ),
                          child: const Text(
                            '我有配对码 ›',
                            style: TextStyle(fontFamily: Octo.mono, fontSize: 10.5),
                          ),
                        ),
                      ),
                    ],
                    if (_needsPairing) ...[
                      const SizedBox(height: 14),
                      _PairingCard(
                        code: _code,
                        token: _token,
                        busy: _busy,
                        error: _pairError,
                        onSubmit: _pairAndConnect,
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

/// 配对卡：这台机器开着设备令牌时展开。
class _PairingCard extends StatelessWidget {
  const _PairingCard({
    required this.code,
    required this.token,
    required this.busy,
    required this.error,
    required this.onSubmit,
  });

  final TextEditingController code;
  final TextEditingController token;
  final bool busy;
  final String? error;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    return RoundedPanel(
      borderColor: Octo.teal.withValues(alpha: .35),
      padding: const EdgeInsets.fromLTRB(14, 13, 14, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.key_outlined, size: 15, color: Octo.teal),
              SizedBox(width: 8),
              Text(
                '需要配对码',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Colors.white),
              ),
            ],
          ),
          const SizedBox(height: 8),
          const Text(
            '这台电脑开了设备令牌。在电脑上打开「设置 → 手机配对」，生成 6 位码（2 分钟内有效、只能用一次）。',
            style: TextStyle(
              fontFamily: Octo.mono,
              fontSize: 10,
              height: 1.75,
              color: Octo.dim,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: code,
            keyboardType: TextInputType.number,
            inputFormatters: [
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(6),
            ],
            style: const TextStyle(
              fontFamily: Octo.mono,
              fontSize: 20,
              letterSpacing: 6,
              color: Colors.white,
            ),
            decoration: const InputDecoration(hintText: '6 位配对码'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: token,
            autocorrect: false,
            enableSuggestions: false,
            style: const TextStyle(
              fontFamily: Octo.mono,
              fontSize: 10.5,
              color: Octo.ink,
            ),
            decoration: const InputDecoration(
              hintText: '或者直接粘贴设备令牌（可选）',
            ),
          ),
          if (error != null) ...[
            const SizedBox(height: 10),
            Text(
              error!,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10,
                height: 1.7,
                color: Octo.red,
              ),
            ),
          ],
          const SizedBox(height: 12),
          PrimaryButton(label: '配对并连接', busy: busy, onPressed: onSubmit),
        ],
      ),
    );
  }
}

class _ScanPlaceholder extends StatelessWidget {
  const _ScanPlaceholder();

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 140,
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
          '配对码在电脑的「设置 → 手机配对」里\n扫码配对以后再做\n现在先填地址和 6 位码',
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
