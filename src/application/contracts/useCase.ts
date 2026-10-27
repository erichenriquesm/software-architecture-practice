type Input = {};
type Output = {};

export interface UseCase {
    exec(input: Input): Promise<Output|void> | Output|void;
}