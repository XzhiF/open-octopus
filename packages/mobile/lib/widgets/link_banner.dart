import 'package:flutter/material.dart';

import '../app/theme.dart';
import '../core/models/device.dart';
import 'panel.dart';

/// 链路状态条：离线 / 未就绪时压一条，别让人对着转圈猜。
/// 正常（运行中 / 未知）时整块不画。
class LinkBanner extends StatelessWidget {
  const LinkBanner({super.key, required this.status, this.onRetry});

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
