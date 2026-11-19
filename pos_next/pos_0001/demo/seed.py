"""Demo data seed for the pos_0001 dev site (docs/SPEC.md section 3).

Run:
    bench --site pos.test execute pos_next.pos_0001.demo.seed.run
    bench --site pos.test execute pos_next.pos_0001.demo.seed.run --kwargs "{'item_count': 500}"

Creates (idempotent, safe to re-run):
- Setup wizard: company "Demo Trading LLC" (DTL), UAE, AED, Asia/Dubai.
- Sales tax template "UAE VAT 5% - DTL" (created by the ERPNext UAE setup).
- Modes of payment Cash / Card / Bank Transfer with company accounts.
  Credit sales use POS Next's allow_credit_sale / allow_partial_payment, not a mode.
- Two POS Profiles ("Main Till", "Express Till") with POS Next POS Settings.
- 20,000 regular items with EAN-13 barcodes (GS1 prefix 629) and Standard Selling prices.
- 50 weighed items (UOM Kg, codes PLU-12345 .. PLU-12394).
- 5 sales persons, a walk-in customer and two credit customers.
- Opening stock in "Stores - DTL" through Stock Reconciliation.
- A cashier user cashier@pos.test (password "cashier") with the POSNext Cashier role.

Demo data only. Never run on a production site.
"""

from __future__ import annotations

import random

import frappe
from frappe.utils import add_days, getdate, nowdate

COMPANY = "Demo Trading LLC"
ABBR = "DTL"
COUNTRY = "United Arab Emirates"
CURRENCY = "AED"
PRICE_LIST = "Standard Selling"
WAREHOUSE = f"Stores - {ABBR}"
TAX_TEMPLATE = f"UAE VAT 5% - {ABBR}"
ITEM_GROUPS = ["Groceries", "Beverages", "Household", "Personal Care", "Snacks", "Frozen"]
WEIGHED_GROUP = "Fresh Produce"
FIRST_PLU = 12345
WEIGHED_COUNT = 50
SALES_PERSONS = ["Ahmed Ali", "Fatima Hassan", "Omar Khalid", "Sara Nasser", "Yusuf Rahman"]
BATCH = 500


def run(item_count: int = 20000) -> None:
	if frappe.conf.get("developer_mode") != 1:
		frappe.throw("Seed runs only on a developer_mode site.")
	random.seed(1)
	setup_wizard()
	frappe.db.commit()
	bank_account = ensure_accounts()
	modes = ensure_modes_of_payment(bank_account)
	ensure_item_groups()
	ensure_sales_persons()
	ensure_customers()
	frappe.db.commit()
	create_items(item_count)
	create_weighed_items()
	mark_demo_items_sellable()
	frappe.db.commit()
	opening_stock()
	ensure_cashier()
	for name in ("Main Till", "Express Till"):
		ensure_pos_profile(name, modes)
	frappe.db.commit()
	print("Seed done:", summary())


def setup_wizard() -> None:
	if frappe.is_setup_complete():
		return
	from frappe.desk.page.setup_wizard.setup_wizard import setup_complete

	year = getdate(nowdate()).year
	setup_complete(
		{
			"language": "English",
			"country": COUNTRY,
			"timezone": "Asia/Dubai",
			"currency": CURRENCY,
			"full_name": "Demo Admin",
			"email": "admin@pos.test",
			"password": "admin",
			"company_name": COMPANY,
			"company_abbr": ABBR,
			"chart_of_accounts": "Standard",
			"fy_start_date": f"{year}-01-01",
			"fy_end_date": f"{year}-12-31",
			"setup_demo": 0,
		}
	)
	frappe.clear_cache()
	if not frappe.db.exists("Company", COMPANY):
		frappe.throw("Setup wizard did not create the company; see Error Log.")


def ensure_accounts() -> str:
	name = f"Demo Bank - {ABBR}"
	if not frappe.db.exists("Account", name):
		parent = frappe.db.get_value(
			"Account", {"company": COMPANY, "account_type": "Bank", "is_group": 1}, "name"
		)
		frappe.get_doc(
			{
				"doctype": "Account",
				"account_name": "Demo Bank",
				"company": COMPANY,
				"parent_account": parent,
				"account_type": "Bank",
				"account_currency": CURRENCY,
			}
		).insert()
	return name


def ensure_modes_of_payment(bank_account: str) -> list[str]:
	cash_account = frappe.db.get_value("Company", COMPANY, "default_cash_account")
	spec = [("Cash", "Cash", cash_account), ("Card", "Bank", bank_account), ("Bank Transfer", "Bank", bank_account)]
	for mode, mode_type, account in spec:
		doc = (
			frappe.get_doc("Mode of Payment", mode)
			if frappe.db.exists("Mode of Payment", mode)
			else frappe.new_doc("Mode of Payment")
		)
		doc.mode_of_payment = mode
		doc.type = mode_type
		doc.enabled = 1
		if not any(a.company == COMPANY for a in doc.accounts):
			doc.append("accounts", {"company": COMPANY, "default_account": account})
		doc.save()
	return [m[0] for m in spec]


def ensure_item_groups() -> None:
	for group in [*ITEM_GROUPS, WEIGHED_GROUP]:
		if not frappe.db.exists("Item Group", group):
			frappe.get_doc(
				{"doctype": "Item Group", "item_group_name": group, "parent_item_group": "All Item Groups"}
			).insert()


def ensure_sales_persons() -> None:
	root = frappe.db.get_value("Sales Person", {"is_group": 1, "parent_sales_person": ["in", ["", None]]})
	for i, person in enumerate(SALES_PERSONS):
		if not frappe.db.exists("Sales Person", person):
			frappe.get_doc(
				{
					"doctype": "Sales Person",
					"sales_person_name": person,
					"parent_sales_person": root,
					"commission_rate": [1, 1.5, 2, 2.5, 3][i],
					"enabled": 1,
				}
			).insert()


def leaf(doctype: str, preferred: str) -> str:
	if frappe.db.get_value(doctype, preferred, "is_group") == 0:
		return preferred
	return frappe.db.get_value(doctype, {"is_group": 0}, "name")


def ensure_customers() -> None:
	customers = [("Walk-in Customer", 0), ("Al Noor Restaurant", 5000), ("Gulf Office Supplies", 10000)]
	for name, credit_limit in customers:
		if frappe.db.exists("Customer", name):
			continue
		doc = frappe.get_doc(
			{
				"doctype": "Customer",
				"customer_name": name,
				"customer_type": "Individual" if credit_limit == 0 else "Company",
				"customer_group": leaf("Customer Group", "Individual" if credit_limit == 0 else "Commercial"),
				"territory": leaf("Territory", COUNTRY),
			}
		)
		if credit_limit:
			doc.append("credit_limits", {"company": COMPANY, "credit_limit": credit_limit})
		doc.insert()


def ean13(body12: str) -> str:
	total = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(body12))
	return body12 + str((10 - total % 10) % 10)


def create_items(item_count: int) -> None:
	existing = frappe.db.count("Item", {"item_code": ["like", "ITM-%"]})
	if existing >= item_count:
		return
	words_a = ["Fresh", "Classic", "Premium", "Organic", "Family", "Daily", "Golden", "Royal", "Pure", "Natural"]
	words_b = ["Rice", "Milk", "Juice", "Tea", "Coffee", "Soap", "Shampoo", "Biscuits", "Chips", "Water",
		"Yogurt", "Cheese", "Bread", "Pasta", "Oil", "Sugar", "Dates", "Nuts", "Tissue", "Detergent"]
	sizes = ["250g", "500g", "1kg", "330ml", "1L", "1.5L", "6pc", "12pc", "200ml", "2kg"]
	frappe.flags.in_import = True
	for n in range(existing + 1, item_count + 1):
		code = f"ITM-{n:05d}"
		if frappe.db.exists("Item", code):
			continue
		name = f"{random.choice(words_a)} {random.choice(words_b)} {random.choice(sizes)} #{n}"
		rate = round(random.uniform(1, 150), 2)
		item = frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": code,
				"item_name": name,
				"item_group": random.choice(ITEM_GROUPS),
				"stock_uom": "Nos",
				"is_stock_item": 1,
				"is_sales_item": 1,
				"is_purchase_item": 1,
				"include_item_in_manufacturing": 0,
				"valuation_rate": round(rate * 0.7, 2),
				"standard_rate": rate,
				"barcodes": [{"barcode": ean13(f"629{n:09d}"), "barcode_type": "EAN"}],
				"item_defaults": [{"company": COMPANY, "default_warehouse": WAREHOUSE}],
			}
		)
		item.insert(ignore_permissions=True)
		if n % BATCH == 0:
			frappe.db.commit()
			print(f"items: {n}/{item_count}")
	frappe.flags.in_import = False
	frappe.db.commit()


def mark_demo_items_sellable() -> None:
	"""Items inserted with frappe.flags.in_import skip doctype defaults, so is_sales_item ends up 0."""
	item = frappe.qb.DocType("Item")
	(
		frappe.qb.update(item)
		.set(item.is_sales_item, 1)
		.set(item.is_purchase_item, 1)
		.where(item.item_code.like("ITM-%") | item.item_code.like("PLU-%"))
		.where((item.is_sales_item == 0) | (item.is_purchase_item == 0))
	).run()


def create_weighed_items() -> None:
	produce = ["Tomato", "Cucumber", "Potato", "Onion", "Apple", "Banana", "Orange", "Grapes", "Carrot", "Lemon"]
	for i in range(WEIGHED_COUNT):
		plu = FIRST_PLU + i
		code = f"PLU-{plu}"
		if frappe.db.exists("Item", code):
			continue
		rate = round(random.uniform(3, 40), 2)
		frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": code,
				"item_name": f"{produce[i % len(produce)]} (per kg) {plu}",
				"description": f"Weighed item, scale PLU {plu}",
				"item_group": WEIGHED_GROUP,
				"stock_uom": "Kg",
				"is_stock_item": 1,
				"valuation_rate": round(rate * 0.6, 2),
				"standard_rate": rate,
				"item_defaults": [{"company": COMPANY, "default_warehouse": WAREHOUSE}],
			}
		).insert(ignore_permissions=True)


def opening_stock() -> None:
	"""Give every demo item stock: 100 Nos for regular items, 50 kg for weighed items."""
	has_stock = frappe.qb.DocType("Bin")
	stocked = set(
		frappe.qb.from_(has_stock).select(has_stock.item_code).where(has_stock.warehouse == WAREHOUSE).run(pluck=True)
	)
	items = frappe.get_all(
		"Item",
		filters={"item_code": ["like", "ITM-%"], "is_stock_item": 1},
		fields=["item_code", "valuation_rate"],
		order_by="item_code",
	) + frappe.get_all(
		"Item", filters={"item_code": ["like", "PLU-%"]}, fields=["item_code", "valuation_rate"], order_by="item_code"
	)
	todo = [i for i in items if i.item_code not in stocked]
	posting = add_days(nowdate(), -1)
	for start in range(0, len(todo), BATCH):
		chunk = todo[start : start + BATCH]
		sr = frappe.get_doc(
			{
				"doctype": "Stock Reconciliation",
				"company": COMPANY,
				"purpose": "Opening Stock",
				"posting_date": posting,
				"set_posting_time": 1,
				"expense_account": f"Temporary Opening - {ABBR}",
				"items": [
					{
						"item_code": i.item_code,
						"warehouse": WAREHOUSE,
						"qty": 50 if i.item_code.startswith("PLU-") else 100,
						"valuation_rate": i.valuation_rate or 1,
					}
					for i in chunk
				],
			}
		)
		sr.insert(ignore_permissions=True)
		sr.submit()
		frappe.db.commit()
		print(f"opening stock: {start + len(chunk)}/{len(todo)}")


def ensure_cashier() -> None:
	email = "cashier@pos.test"
	if frappe.db.exists("User", email):
		return
	user = frappe.get_doc(
		{
			"doctype": "User",
			"email": email,
			"first_name": "Demo",
			"last_name": "Cashier",
			"send_welcome_email": 0,
			"roles": [{"role": "POSNext Cashier"}, {"role": "Sales User"}],
		}
	)
	user.insert(ignore_permissions=True)
	from frappe.utils.password import update_password

	update_password(email, "cashier")  # demo password; skips the strength check


def ensure_pos_profile(name: str, modes: list[str]) -> None:
	if not frappe.db.exists("POS Profile", name):
		profile = frappe.get_doc(
			{
				"doctype": "POS Profile",
				"name": name,
				"__newname": name,
				"company": COMPANY,
				"currency": CURRENCY,
				"warehouse": WAREHOUSE,
				"customer": "Walk-in Customer",
				"selling_price_list": PRICE_LIST,
				"taxes_and_charges": TAX_TEMPLATE,
				"write_off_account": f"Write Off - {ABBR}",
				"write_off_cost_center": f"Main - {ABBR}",
				"write_off_limit": 1,
				"update_stock": 1,
				"payments": [{"mode_of_payment": m, "default": 1 if m == "Cash" else 0} for m in modes],
				"applicable_for_users": [
					{"user": u, "default": 1 if name == "Main Till" else 0}
					for u in ("Administrator", "admin@pos.test", "cashier@pos.test")
				],
			}
		)
		profile.insert(ignore_permissions=True)
	if not frappe.db.exists("POS Settings", {"pos_profile": name}):
		frappe.get_doc(
			{
				"doctype": "POS Settings",
				"pos_profile": name,
				"enabled": 1,
				"allow_credit_sale": 1,
				"allow_partial_payment": 1,
				"allow_return": 1,
				"enable_sales_persons": "Multiple",
				"tax_inclusive": 0,
			}
		).insert(ignore_permissions=True)


def summary() -> dict[str, int]:
	return {
		"items": frappe.db.count("Item", {"item_code": ["like", "ITM-%"]}),
		"weighed_items": frappe.db.count("Item", {"item_code": ["like", "PLU-%"]}),
		"item_prices": frappe.db.count("Item Price", {"price_list": PRICE_LIST}),
		"sales_persons": frappe.db.count("Sales Person", {"is_group": 0}),
		"pos_profiles": frappe.db.count("POS Profile"),
		"customers": frappe.db.count("Customer"),
	}
