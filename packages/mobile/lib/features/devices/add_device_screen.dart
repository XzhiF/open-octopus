import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/haptics.dart';
import '../../core/http.dart';
import '../../core/models/device.dart';
import '../../core/nav.dart';
import '../../core/pairing.dart';
import '../../core/providers.dart';
import '../../widgets/octo_bar.dart';
import '../../widgets/panel.dart';
import '../../widgets/scene_background.dart';

/// B · 添加设备（原型 `mobile-v1.html` B 屏）：一张表填完 ——
/// Tailscale 域名 + 名字 + 6 位配对码（或直接粘贴设备令牌）。
///
/// 流程：填了配对码就直接兑换令牌；没填先探活（免鉴权的 /health）→
/// 试 `/api/cabins`，401 就提示补配对码，再点「连接」走兑换。
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
  final FocusNode _codeFocus = FocusNode();
  bool _busy = false;
  bool _showToken = false;

  /// 探活发现这台机器开了设备令牌：把配对码框标出来，并把焦点送过去。
  bool _needsCode = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    _name.dispose();
    _code.dispose();
    _token.dispose();
    _codeFocus.dispose();
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

  /// 连接：有配对码就兑换；没有就探活后试直连，401 再把配对码框标出来。
  Future<void> _connect() async {
    if (!_validateUrl()) return;
    if (_code.text.trim().isNotEmpty) return _pairAndConnect();

    setState(() {
      _busy = true;
      _error = null;
      _needsCode = false;
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
          _needsCode = true;
          _error = pasted.isEmpty
              ? '这台电脑开了设备令牌 —— 在上面填 6 位配对码，再点「连 接」'
              : '粘贴的令牌无效 —— 用配对码重新换一条';
        });
        _codeFocus.requestFocus();
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
      setState(() => _error = '配对码是 6 位数字 —— 在电脑「设置 → 手机配对」生成；也可以直接粘贴令牌');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _needsCode = false;
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
        _error = e.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = describeError(e);
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
    // 换掉「添加设备」这一页：栈里留下设备列表，返回时回得去。
    context.pushReplacement('/device');
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
                onBack: () => back(context),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                  children: [
                    const RoundedPanel(
                      padding: EdgeInsets.fromLTRB(14, 13, 14, 13),
                      child: Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(text: '在电脑上打开 '),
                            TextSpan(
                              text: 'Octopus → 设置 → 手机配对',
                              style: TextStyle(color: Colors.white),
                            ),
                            TextSpan(text: '，生成 6 位配对码\n（2 分钟有效、一次性；也可以直接粘贴设备令牌）'),
                          ],
                        ),
                        style: TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 10.5,
                          height: 1.75,
                          letterSpacing: .3,
                          color: Octo.dim,
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    const SectionTitle('手动填'),
                    const SizedBox(height: 11),
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
                    const SizedBox(height: 11),
                    TextField(
                      controller: _name,
                      style: const TextStyle(fontSize: 13, color: Octo.ink),
                      decoration: const InputDecoration(hintText: '名字（可留空，默认取域名第一段）'),
                    ),
                    const SizedBox(height: 11),
                    TextField(
                      controller: _code,
                      focusNode: _codeFocus,
                      keyboardType: TextInputType.number,
                      inputFormatters: [
                        FilteringTextInputFormatter.digitsOnly,
                        LengthLimitingTextInputFormatter(6),
                      ],
                      style: const TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 13,
                        letterSpacing: 1.2,
                        color: Octo.ink,
                      ),
                      decoration: InputDecoration(
                        hintText: '配对码 · 6 位',
                        enabledBorder: _needsCode
                            ? OutlineInputBorder(
                                borderRadius: BorderRadius.circular(Octo.rM),
                                borderSide: BorderSide(
                                  color: Octo.teal.withValues(alpha: .55),
                                  width: 1.2,
                                ),
                              )
                            : null,
                      ),
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
                    if (_showToken) ...[
                      const SizedBox(height: 11),
                      TextField(
                        controller: _token,
                        autocorrect: false,
                        enableSuggestions: false,
                        style: const TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 10.5,
                          color: Octo.ink,
                        ),
                        decoration: const InputDecoration(
                          hintText: '设备令牌（粘贴后直接连接）',
                        ),
                      ),
                    ] else ...[
                      const SizedBox(height: 4),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton(
                          onPressed: () => setState(() => _showToken = true),
                          style: TextButton.styleFrom(
                            foregroundColor: Octo.teal,
                            padding: EdgeInsets.zero,
                            minimumSize: const Size(0, 32),
                          ),
                          child: const Text(
                            '直接粘贴令牌 ›',
                            style: TextStyle(fontFamily: Octo.mono, fontSize: 10.5),
                          ),
                        ),
                      ),
                    ],
                    if (_error != null) ...[
                      const SizedBox(height: 10),
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
                    const SizedBox(height: 16),
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
