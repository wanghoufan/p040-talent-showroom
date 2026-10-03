import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
afterEach(cleanup);
// jsdom 不实现视口滚动；路由重置滚动在真机另外验收。
Object.defineProperty(window,'scrollTo',{value:()=>undefined,writable:true});
