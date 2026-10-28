import type { DomainEvent } from './domainEvent.js';

export interface TradeExecuted extends DomainEvent {
  readonly type: 'TradeExecuted';
  readonly tradeId: string;
  readonly marketId: string;
  readonly buyOrderId: string;
  readonly sellOrderId: string;
  readonly buyAccountId: string;
  readonly sellAccountId: string;
  readonly side: string;
  readonly quantity: string;
  readonly price: string;
  readonly bookSequence: number;
}
