// Shared test fixtures: rules A and B of SPEC F5.

/** Rule A of SPEC F5: prefix 20, weight in kg. */
export const RULE_A = {
	name: "Rule A",
	prefix: "20",
	total_length: 13,
	item_code_start: 3,
	item_code_length: 5,
	item_match: "Scale PLU",
	value_type: "Weight",
	value_start: 8,
	value_length: 5,
	decimals: 3,
	uom: "Kg",
	check_digit_mode: "Validate",
	priority: 10,
}

/** Rule B of SPEC F5: prefix 22, price in AED. */
export const RULE_B = {
	...RULE_A,
	name: "Rule B",
	prefix: "22",
	value_type: "Price",
	decimals: 2,
}
