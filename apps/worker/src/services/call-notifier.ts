// TalkPlatform: 通話リンクの LINE Push (Flex Message + テキストフォールバック)。
import { LineClient } from '@line-crm/line-sdk';
import type { CallLinkSender } from './call-session.js';

export function renderCallLinkText(ctx: { menuName: string; staffName: string; startsAtJst: string }, callUrl: string): string {
  return `まもなくお電話のお時間です。\nメニュー: ${ctx.menuName}\n担当: ${ctx.staffName}\n日時: ${ctx.startsAtJst}\n\n下のリンクから通話室に入室してください（開始10分前から入れます）。\n${callUrl}`;
}

export function buildCallLinkFlex(
  ctx: { menuName: string; staffName: string; startsAtJst: string },
  callUrl: string,
): Record<string, unknown> {
  return {
    type: 'flex',
    altText: renderCallLinkText(ctx, callUrl),
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'まもなくお電話のお時間です', weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text: `メニュー: ${ctx.menuName}`, size: 'sm', wrap: true },
          { type: 'text', text: `担当: ${ctx.staffName}`, size: 'sm', wrap: true },
          { type: 'text', text: `日時: ${ctx.startsAtJst}`, size: 'sm', wrap: true },
          { type: 'text', text: '開始10分前から入室できます。', size: 'xs', color: '#888888', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#06C755',
            action: { type: 'uri', label: '通話室に入る', uri: callUrl },
          },
        ],
      },
    },
  };
}

export const sendCallLinkNotification: CallLinkSender = async (p) => {
  const client = new LineClient(p.channelAccessToken);
  await client.pushMessage(p.toLineUserId, [buildCallLinkFlex(p.ctx, p.callUrl) as never]);
};
