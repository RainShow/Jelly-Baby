export const MOBILE_PLATFORM_QUERY='(pointer: coarse)';

export type PlatformProfile={
  readonly mobile:boolean;
  readonly maxDpr:number;
  readonly reflectionFacesPerFrame:number;
  readonly bloomResolutionScale:number;
  readonly surfaceShadowSize:number;
  readonly cameraOnlyOpticalHz:number;
};

const DESKTOP_PROFILE:PlatformProfile={
  mobile:false,
  maxDpr:1.7,
  reflectionFacesPerFrame:4,
  bloomResolutionScale:.5,
  surfaceShadowSize:2048,
  cameraOnlyOpticalHz:30,
};

const MOBILE_PROFILE:PlatformProfile={
  mobile:true,
  maxDpr:1.5,
  reflectionFacesPerFrame:2,
  bloomResolutionScale:.4,
  surfaceShadowSize:1536,
  cameraOnlyOpticalHz:20,
};

export function platformProfile(mobile:boolean):PlatformProfile {
  return mobile?MOBILE_PROFILE:DESKTOP_PROFILE;
}

/** The HTML bootstrap locks this before resource discovery so preload and runtime agree. */
export function startupPlatformProfile():PlatformProfile {
  const locked=document.documentElement.dataset.jellyPlatform;
  const mobile=locked==='mobile'||(locked!=='desktop'&&window.matchMedia(MOBILE_PLATFORM_QUERY).matches);
  return platformProfile(mobile);
}
