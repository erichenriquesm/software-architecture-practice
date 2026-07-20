import { expect, test, describe } from "vitest";
import { Register } from "../../usecases/register";
import { RegisterUserInputDTO } from "../../dtos/registerUserInputDTO";

describe("Use Case: Register Account", () => {
  
  test("Should create an account successfully when data is valid", () => {
    // Given
    const input: RegisterUserInputDTO = {
      name: "Eric Motta",
      email: "eric@gmail.com",
      phone: "5544999999999"
    };
    const useCase = new Register();

    // When
    const output = useCase.exec(input);

    // Then
    expect(output.id).toBeDefined();
    expect(typeof output.id).toBe("string");
  });

  test("Should not create an account if the full name lacks a surname", () => {
    // Given
    const input: RegisterUserInputDTO = {
      name: "Eric", // Single name triggers FullName validation error
      email: "eric@gmail.com",
      phone: "5544999999999"
    };
    const useCase = new Register();

    // When & Then
    expect(() => useCase.exec(input)).toThrowError("Full name is not set");
  });

  test("Should not create an account if the email format is invalid", () => {
    // Given
    const input: RegisterUserInputDTO = {
      name: "Eric Motta",
      email: "invalid-email.com", // Lacks '@' character, triggers Email validation error
      phone: "5544999999999"
    };
    const useCase = new Register();

    // When & Then
    expect(() => useCase.exec(input)).toThrowError("Email is not valid");
  });

  test("Should not create an account if the phone number is too short after cleanup", () => {
    // Given
    const input: RegisterUserInputDTO = {
      name: "Eric Motta",
      email: "eric@gmail.com",
      phone: "123" // Less than 7 digits, triggers Phone validation error
    };
    const useCase = new Register();

    // When & Then
    expect(() => useCase.exec(input)).toThrowError("Phone is not valid");
  });

});
