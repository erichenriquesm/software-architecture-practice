import { OrderNotFoundError } from '../../domain/errors.js';
import { OrderId } from '../../domain/valueObjects/orderId.js';
import type { OrderDao } from '../contracts/orderDao.js';
import type { OrderView } from '../dtos/orderView.js';
import type { UseCase } from './useCase.js';

export class GetOrder implements UseCase<[orderId: string], OrderView> {
  constructor(private readonly orderDao: OrderDao) {}

  async execute(rawOrderId: string): Promise<OrderView> {
    const orderId = OrderId.from(rawOrderId).value;
    const order = await this.orderDao.findById(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    return order;
  }
}
