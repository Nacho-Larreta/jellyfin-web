export const PROFILE_PIN_PATTERN = '[0-9]{4,8}';

const profilePinExpression = /^[\x30-\x39]{4,8}$/;

export function isValidProfilePin(pin) {
    return typeof pin === 'string' && profilePinExpression.test(pin);
}

export function assertValidProfilePin(pin) {
    if (!isValidProfilePin(pin)) {
        throw new TypeError('A profile PIN must contain 4 to 8 ASCII digits.');
    }

    return pin;
}

export async function requestValidProfilePin(requestPin, onInvalidPin) {
    while (true) {
        let pin;

        try {
            pin = await requestPin();
        } catch {
            return null;
        }

        if (isValidProfilePin(pin)) {
            return pin;
        }

        await onInvalidPin();
    }
}
