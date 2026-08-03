import React from 'react';

const icon = (paths: React.ReactNode) => function Icon({ size = 24, ...props }: any) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths}</svg>;
};

export const Bot = icon(<><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M9 3h6M12 3v4M8 13h.01M16 13h.01M9 17h6"/></>);
export const Check = icon(<path d="m5 12 4 4L19 6"/>);
export const ChevronRight = icon(<path d="m9 18 6-6-6-6"/>);
export const ChevronDown = icon(<path d="m6 9 6 6 6-6"/>);
export const CircleAlert = icon(<><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></>);
export const CircleStop = icon(<><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/></>);
export const Download = icon(<><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14"/></>);
export const Eye = icon(<><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>);
export const Film = icon(<><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4m10 0h4M3 15h4m10 0h4"/></>);
export const FolderOpen = icon(<path d="M3 18V7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v2H7l-4 7Z"/>);
export const Gauge = icon(<><path d="M4 16a8 8 0 1 1 16 0"/><path d="m12 14 4-4"/></>);
export const Home = icon(<><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></>);
export const Image = icon(<><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-5 4 4 3-3 6 6"/></>);
export const ListVideo = icon(<><path d="M8 6h12M8 12h12M8 18h12"/><path d="m3 5 2 1-2 1V5Zm0 6 2 1-2 1v-2Zm0 6 2 1-2 1v-2Z"/></>);
export const Menu = icon(<path d="M4 6h16M4 12h16M4 18h16"/>);
export const X = icon(<path d="M6 6 18 18M18 6 6 18"/>);
export const LockKeyhole = icon(<><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>);
export const UnlockKeyhole = icon(<><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-2.5M12 14v3"/></>);
export const Play = icon(<path d="m8 5 11 7-11 7V5Z"/>);
export const Plus = icon(<path d="M12 5v14M5 12h14"/>);
export const RefreshCw = icon(<><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8A7 7 0 0 1 18 6l2 6M3.9 12l2 6a7 7 0 0 0 11.9-2"/></>);
export const Settings = icon(<><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a8 8 0 0 0-1.7-1L14.5 3h-5L9 6a8 8 0 0 0-1.7 1L5 6 3 9.5 5 11a7 7 0 0 0 0 2l-2 1.5L5 18l2.3-1a8 8 0 0 0 1.7 1l.5 3h5l.5-3a8 8 0 0 0 1.7-1l2.3 1 2-3.5-2-1.5a7 7 0 0 0 .1-1Z"/></>);
export const ShieldCheck = icon(<><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m8.5 12 2.2 2.2L16 9"/></>);
export const Square = icon(<rect x="5" y="5" width="14" height="14" rx="2"/>);
