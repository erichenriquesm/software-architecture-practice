import { expect, test, describe } from "vitest";
import { SendUser } from "../../usecases/sendUser";
import { UserPayload, UserSender } from "../../ports/userSender";

class FakeUserSender implements UserSender {
  sent: UserPayload[] = [];
  async send(user: UserPayload): Promise<void> {
    this.sent.push(user);
  }
}

describe("Use Case: Send User", () => {

  test("Should send the user through the port when data is valid", async () => {
    // Given
    const sender = new FakeUserSender();
    const useCase = new SendUser(sender);

    // When
    await useCase.exec({ name: "Eric Motta", email: "eric@gmail.com", phone: "5544999999999" });

    // Then
    expect(sender.sent).toEqual([{ name: "Eric Motta", email: "eric@gmail.com", phone: "5544999999999" }]);
  });

  test("Should not send anything when domain validation fails", async () => {
    // Given
    const sender = new FakeUserSender();
    const useCase = new SendUser(sender);

    // When & Then
    await expect(useCase.exec({ name: "Eric", email: "eric@gmail.com", phone: "5544999999999" }))
      .rejects.toThrowError("Full name is not set");
    expect(sender.sent).toHaveLength(0);
  });

});
