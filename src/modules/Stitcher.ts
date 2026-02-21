import { Message, TargetPayload } from '../types';

export class Stitcher {
  public static orderKeysDeterministically(obj: any): any {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(Stitcher.orderKeysDeterministically);
    const sortedObj: Record<string, any> = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
      if (key !== '_cache_breakpoint') {
         sortedObj[key] = Stitcher.orderKeysDeterministically(obj[key]);
      } else {
         sortedObj[key] = obj[key];
      }
    }
    return sortedObj;
  }

  public static stringifyPayload(payload: any): string {
    return JSON.stringify(Stitcher.orderKeysDeterministically(payload));
  }

  public compile(messages: Message[]): { messages: Message[] } {
    return {
      messages: messages.map(msg => Stitcher.orderKeysDeterministically(msg) as Message)
    };
  }
}
