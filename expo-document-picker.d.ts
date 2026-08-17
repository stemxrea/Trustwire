declare module 'expo-document-picker' {
  export type DocumentPickerAsset = {
    uri: string;
    name: string;
    size?: number;
    mimeType?: string | null;
    lastModified?: number;
  };

  export type DocumentPickerResult =
    | { canceled: true; assets: null }
    | { canceled: false; assets: DocumentPickerAsset[] };

  export type DocumentPickerOptions = {
    type?: string | string[];
    copyToCacheDirectory?: boolean;
    multiple?: boolean;
  };

  export function getDocumentAsync(options?: DocumentPickerOptions): Promise<DocumentPickerResult>;
}
