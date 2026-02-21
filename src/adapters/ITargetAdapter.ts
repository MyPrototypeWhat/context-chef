import { Message, TargetPayload } from '../types';

export interface ITargetAdapter {
  compile(messages: Message[]): TargetPayload;
}
