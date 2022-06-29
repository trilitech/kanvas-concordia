import { NetworkType } from '@airgap/beacon-sdk';
import { Networks } from 'kukai-embed';

export const RPC_URL =
    process.env.REACT_APP_RPC_URL ?? 'http://hangzhounet.tzconnect.berlin/';
export const NETWORK: keyof typeof NetworkType = 'ITHACANET';
export const KUKAI_NETWORK: keyof typeof Networks | 'ithacanet' = 'ithacanet';

export const PROFILE_PICTURES_ENABLED: boolean =
    (process.env.REACT_APP_PROFILE_PICTURES_ENABLED || 'no') === 'yes';
