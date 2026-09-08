import { launchCamera, launchImageLibrary, type ImagePickerResponse } from 'react-native-image-picker';
import { supabase } from './supabase';

/**
 * Profile photo: pick (camera or library), shrink on-device, upload to the
 * `avatars` bucket under the user's own folder, hand back the public URL.
 * The bucket policy only lets a user write inside their own folder, and
 * update_my_profile() only accepts URLs from that folder.
 */

export type AvatarSource = 'camera' | 'library';

export interface PickedImage {
  base64: string;
  mime: string;
}

const BUCKET = 'avatars';

export async function pickAvatar(source: AvatarSource): Promise<PickedImage | null> {
  const options = {
    mediaType: 'photo' as const,
    includeBase64: true,
    maxWidth: 512,
    maxHeight: 512,
    quality: 0.8 as const,
    selectionLimit: 1,
    cameraType: 'front' as const,
    saveToPhotos: false,
    presentationStyle: 'fullScreen' as const,
  };
  const result: ImagePickerResponse =
    source === 'camera' ? await launchCamera(options) : await launchImageLibrary(options);

  if (result.didCancel) {
    return null;
  }
  if (result.errorCode) {
    throw new Error(pickerErrorText(result.errorCode, result.errorMessage));
  }
  const asset = result.assets?.[0];
  if (!asset?.base64) {
    throw new Error("Couldn't read that photo.");
  }
  return { base64: asset.base64, mime: asset.type ?? 'image/jpeg' };
}

function pickerErrorText(code: string, message?: string): string {
  switch (code) {
    case 'camera_unavailable':
      return 'No camera is available on this device.';
    case 'permission':
      return 'Fittr needs permission to use that. Allow it in Settings and try again.';
    default:
      return message ?? 'Could not pick a photo.';
  }
}

/** Base64 to bytes without a Buffer polyfill (Hermes ships atob). */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function avatarPath(userId: string, mime: string): string {
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return `${userId}/avatar.${ext}`;
}

/** Uploads (overwriting) and returns a cache-busted public URL. */
export async function uploadAvatar(userId: string, image: PickedImage): Promise<string> {
  const path = avatarPath(userId, image.mime);
  const bytes = base64ToBytes(image.base64);
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes.buffer as ArrayBuffer, { contentType: image.mime, upsert: true });
  if (error) {
    throw new Error(error.message);
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}

/** Deletes every file in the user's avatar folder. */
export async function removeAvatarFiles(userId: string): Promise<void> {
  const { data } = await supabase.storage.from(BUCKET).list(userId);
  const names = (data ?? []).map(f => `${userId}/${f.name}`);
  if (names.length) {
    await supabase.storage.from(BUCKET).remove(names);
  }
}
