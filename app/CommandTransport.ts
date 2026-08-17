import { Buffer } from 'buffer';
import type { BleManager } from 'react-native-ble-plx';

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id: number | string;
  auth?: CommandAuthMetadata;
};

export type CommandAuthMetadata = {
  nonce: string;
  signature: string;
  algorithm: string;
  keyId?: string;
};

export type CommandSignerResult =
  | string
  | {
      signature: string;
      algorithm?: string;
      keyId?: string;
    };

type CommandSignerContext = {
  method: string;
  nonce: string;
  payloadToSign: string;
};

type CommandSigner = (context: CommandSignerContext) => Promise<CommandSignerResult>;

type CommandTransportConfig = {
  webSocket?: WebSocket | null;
  bleManager?: BleManager | null;
  peripheralId?: string | null;
  serviceUUID?: string;
  txCharacteristicUUID?: string;
  rxCharacteristicUUID?: string;
  timeoutMs?: number;
  privilegedMethods?: string[];
  hmacSecret?: string;
  signer?: CommandSigner;
  authRequestMethod?: string;
};

export class CommandTransport {
  private webSocket: WebSocket | null;
  private bleManager: BleManager | null;
  private peripheralId: string | null;
  private serviceUUID?: string;
  private txCharacteristicUUID?: string;
  private rxCharacteristicUUID?: string;
  private timeoutMs: number;
  private privilegedMethods: Set<string>;
  private hmacSecret?: string;
  private signer?: CommandSigner;
  private authRequestMethod: string;
  private requestCounter = 1;

  constructor({
    webSocket = null,
    bleManager = null,
    peripheralId = null,
    serviceUUID,
    txCharacteristicUUID,
    rxCharacteristicUUID,
    timeoutMs = 5000,
    privilegedMethods = ['device/reboot', 'ota/begin_update'],
    hmacSecret,
    signer,
    authRequestMethod = 'auth/request',
  }: CommandTransportConfig) {
    this.webSocket = webSocket;
    this.bleManager = bleManager;
    this.peripheralId = peripheralId;
    this.serviceUUID = serviceUUID;
    this.txCharacteristicUUID = txCharacteristicUUID;
    this.rxCharacteristicUUID = rxCharacteristicUUID;
    this.timeoutMs = timeoutMs;
    this.privilegedMethods = new Set(privilegedMethods);
    this.hmacSecret = hmacSecret;
    this.signer = signer;
    this.authRequestMethod = authRequestMethod;
  }

  setWebSocket(webSocket: WebSocket | null): void {
    this.webSocket = webSocket;
  }

  setBleConnection(bleManager: BleManager | null, peripheralId: string | null): void {
    this.bleManager = bleManager;
    this.peripheralId = peripheralId;
  }

  async executeCommand(method: string, params?: any): Promise<any> {
    const normalizedParams = params ?? {};

    if (this.requiresAuth(method)) {
      const nonce = await this.requestAuthNonce();
      const auth = await this.buildAuthMetadata(method, nonce);
      return this.sendRequest(method, normalizedParams, auth);
    }

    return this.sendRequest(method, normalizedParams);
  }

  setAuthSigner(signer?: CommandSigner): void {
    this.signer = signer;
  }

  setHmacSecret(secret?: string): void {
    this.hmacSecret = secret;
  }

  setPrivilegedMethods(methods: string[]): void {
    this.privilegedMethods = new Set(methods);
  }

  private async sendRequest(method: string, params: any = {}, auth?: CommandAuthMetadata): Promise<any> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id: this.requestCounter++,
      ...(auth ? { auth } : {}),
    };

    if (this.isWebSocketOpen()) {
      const payload = JSON.stringify(request);
      this.webSocket!.send(payload);
      return this.waitForWebSocketResponse(request.id);
    }

    if (this.canUseBle()) {
      const payload = JSON.stringify(request);
      const bytes = this.toUtf8Bytes(payload);
      await this.writeBlePayload(bytes);
      return {
        id: request.id,
        transport: 'ble',
        status: 'sent',
      };
    }

    throw new Error('No active transport available (WebSocket closed and BLE unavailable).');
  }

  rebootDevice(): Promise<any> {
    return this.executeCommand('device/reboot');
  }

  toggleScanner(enabled?: boolean): Promise<any> {
    return this.executeCommand('scanner/toggle', typeof enabled === 'boolean' ? { enabled } : {});
  }

  triggerOtaCheck(): Promise<any> {
    return this.executeCommand('device/otaCheck');
  }

  beginOtaUpdate(params?: any): Promise<any> {
    return this.executeCommand('ota/begin_update', params ?? {});
  }

  private requiresAuth(method: string): boolean {
    return this.privilegedMethods.has(method);
  }

  private async requestAuthNonce(): Promise<string> {
    const response = await this.sendRequest(this.authRequestMethod, {});

    if (typeof response === 'string' && response.trim().length > 0) {
      return response;
    }

    const nonce = response?.nonce ?? response?.challenge ?? response?.random;
    if (typeof nonce === 'string' && nonce.trim().length > 0) {
      return nonce;
    }

    throw new Error('Authentication nonce request failed: missing nonce in auth/request response.');
  }

  private async buildAuthMetadata(method: string, nonce: string): Promise<CommandAuthMetadata> {
    const payloadToSign = `${nonce}:${method}`;

    if (this.signer) {
      const signerResult = await this.signer({ method, nonce, payloadToSign });
      if (typeof signerResult === 'string') {
        return {
          nonce,
          signature: signerResult,
          algorithm: 'CUSTOM-SIGNATURE',
        };
      }

      return {
        nonce,
        signature: signerResult.signature,
        algorithm: signerResult.algorithm || 'CUSTOM-SIGNATURE',
        ...(signerResult.keyId ? { keyId: signerResult.keyId } : {}),
      };
    }

    if (!this.hmacSecret) {
      throw new Error('Privileged command requires authentication signer or HMAC secret.');
    }

    const signature = await this.signHmacSha256(payloadToSign, this.hmacSecret);
    return {
      nonce,
      signature,
      algorithm: 'HMAC-SHA256',
    };
  }

  private async signHmacSha256(message: string, secret: string): Promise<string> {
    const subtle = (globalThis as any)?.crypto?.subtle;
    if (!subtle) {
      throw new Error('HMAC-SHA256 signing is unavailable: no Web Crypto API found. Provide a custom signer.');
    }

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(message);

    const cryptoKey = await subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    const signatureBuffer = await subtle.sign('HMAC', cryptoKey, messageData);
    return Buffer.from(signatureBuffer).toString('hex');
  }

  private isWebSocketOpen(): boolean {
    return !!this.webSocket && this.webSocket.readyState === WebSocket.OPEN;
  }

  private canUseBle(): boolean {
    return !!(
      this.bleManager &&
      this.peripheralId &&
      this.serviceUUID &&
      this.txCharacteristicUUID
    );
  }

  private waitForWebSocketResponse(id: number | string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.webSocket) {
        reject(new Error('WebSocket not available.'));
        return;
      }

      const ws = this.webSocket;
      let done = false;

      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);

        if (typeof ws.removeEventListener === 'function') {
          ws.removeEventListener('message', onMessage as EventListener);
        }
      };

      const onMessage = (event: MessageEvent | any) => {
        const raw = event?.data;
        if (typeof raw !== 'string') return;

        try {
          const message = JSON.parse(raw);
          if (message?.id !== id) return;

          cleanup();
          if (message?.error) {
            reject(message.error);
          } else {
            resolve(message?.result ?? message);
          }
        } catch {
          // ignore non-json or mismatched packets
        }
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`JSON-RPC response timeout for request id ${String(id)}.`));
      }, this.timeoutMs);

      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('message', onMessage as EventListener);
      } else {
        const previous = ws.onmessage;
        ws.onmessage = (event: any) => {
          onMessage(event);
          if (typeof previous === 'function') previous.call(ws, event);
        };
      }
    });
  }

  private async writeBlePayload(bytes: Uint8Array): Promise<void> {
    if (!this.bleManager || !this.peripheralId || !this.serviceUUID || !this.txCharacteristicUUID) {
      throw new Error('BLE transport is missing manager/device/service/characteristic metadata.');
    }

    const base64Payload = Buffer.from(bytes).toString('base64');

    const managerAny = this.bleManager as any;
    if (typeof managerAny.writeCharacteristicWithResponseForDevice === 'function') {
      await managerAny.writeCharacteristicWithResponseForDevice(
        this.peripheralId,
        this.serviceUUID,
        this.txCharacteristicUUID,
        base64Payload,
      );
      return;
    }

    if (typeof managerAny.writeCharacteristicWithoutResponseForDevice === 'function') {
      await managerAny.writeCharacteristicWithoutResponseForDevice(
        this.peripheralId,
        this.serviceUUID,
        this.txCharacteristicUUID,
        base64Payload,
      );
      return;
    }

    throw new Error('BLE manager does not expose a compatible write characteristic method.');
  }

  private toUtf8Bytes(payload: string): Uint8Array {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(payload);
    }
    return Uint8Array.from(Buffer.from(payload, 'utf8'));
  }
}
