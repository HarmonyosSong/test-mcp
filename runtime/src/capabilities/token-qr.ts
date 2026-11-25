import QRCode from 'qrcode';

/** 将 Token 原文编码为 PNG；内容不含登录 URL。 */
export async function tokenToQrPng(token: string): Promise<Buffer> {
  const value = token.trim();
  if (!value) throw new Error('Token is empty');
  if (Buffer.byteLength(value, 'utf8') > 8192) {
    throw new Error('Token exceeds QR capacity');
  }
  return QRCode.toBuffer(value, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 320,
  });
}
