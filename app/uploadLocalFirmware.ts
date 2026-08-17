import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

let activeOtaRequest: XMLHttpRequest | null = null;

function clearSessionRefs(xhr?: XMLHttpRequest) {
  if (!xhr || activeOtaRequest === xhr) {
    activeOtaRequest = null;
  }
}

export function abortActiveOtaSession() {
  if (activeOtaRequest) {
    activeOtaRequest.abort();
    activeOtaRequest = null;
    console.log('[OTA] Active upload transmission aborted cleanly via client command.');
  }
}

export interface UploadOptions {
  deviceIp: string;
  onProgress: (percentage: number) => void;
  onSuccess: () => void;
  onError: (error: string) => void;
}

export interface SecureOtaOptions {
  targetIp: string;
  onProgress: (percent: number) => void;
  onSuccess: () => void;
  onFailure: (errorMessage: string) => void;
}

async function uploadFirmwareBlob(
  targetIp: string,
  secure: boolean,
  onProgress: (percent: number) => void,
  onSuccess: () => void,
  onFailure: (errorMessage: string) => void,
) {
  try {
    abortActiveOtaSession();

    const selection = await DocumentPicker.getDocumentAsync({
      type: 'application/octet-stream',
      copyToCacheDirectory: true,
    });

    if (selection.canceled || !selection.assets?.length) {
      return;
    }

    const fileAsset = selection.assets[0];
    const fileUri = fileAsset.uri;

    const info = await FileSystem.getInfoAsync(fileUri);
    if (!info.exists) {
      throw new Error('Selected file is unavailable in local cache.');
    }

    const fileResponse = await fetch(fileUri);
    if (!fileResponse.ok) {
      throw new Error(`Unable to read selected firmware file (${fileResponse.status}).`);
    }
    const rawFileBlob = await fileResponse.blob();

    const xhr = new XMLHttpRequest();
    activeOtaRequest = xhr;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
        return;
      }

      const total = typeof info.size === 'number' ? info.size : 0;
      if (total > 0) {
        onProgress(Math.min(100, Math.round((e.loaded / total) * 100)));
      }
    });

    xhr.onreadystatechange = () => {
      if (xhr.readyState === XMLHttpRequest.DONE) {
        clearSessionRefs(xhr);
        if (xhr.status === 200 || xhr.status === 202) {
          onSuccess();
        } else {
          onFailure(`Deployment failed status wrapper: ${xhr.status} - ${xhr.responseText}`);
        }
      }
    };

    xhr.onerror = () => {
      clearSessionRefs(xhr);
      onFailure('Network connectivity drop intercepted during OTA upload stream.');
    };

    xhr.onabort = () => {
      clearSessionRefs(xhr);
    };

    const scheme = secure ? 'https' : 'http';
    xhr.open('POST', `${scheme}://${targetIp}/update`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.send(rawFileBlob);
  } catch (err: any) {
    clearSessionRefs();
    onFailure(err.message || 'An unhandled execution failure stopped the local update stack.');
  }
}

export async function executeProductionOtaUpload(
  targetIpOrOptions: string | SecureOtaOptions,
  onProgress?: (percent: number) => void,
  onSuccess?: () => void,
  onFailure?: (err: string) => void,
) {
  if (typeof targetIpOrOptions === 'string') {
    return uploadFirmwareBlob(
      targetIpOrOptions,
      true,
      onProgress || (() => {}),
      onSuccess || (() => {}),
      onFailure || (() => {}),
    );
  }

  return uploadFirmwareBlob(
    targetIpOrOptions.targetIp,
    true,
    targetIpOrOptions.onProgress,
    targetIpOrOptions.onSuccess,
    targetIpOrOptions.onFailure,
  );
}

export async function uploadLocalFirmware({ deviceIp, onProgress, onSuccess, onError }: UploadOptions) {
  return uploadFirmwareBlob(deviceIp, true, onProgress, onSuccess, onError);
}
