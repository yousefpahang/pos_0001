<!--
  Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
  Item Wizard (SPEC F13): /pos/items/new, and /pos/items/edit?item=CODE for "Edit packaging"
  (steps 3-6). Plain questions in 8 steps with back / next, step checks and a progress bar;
  Create writes every ERPNext record in one transaction on the server. Needs to be online.
-->
<template>
	<div class="min-h-screen bg-gray-50 pb-28" data-testid="item-wizard-page" :data-step="w.step.value">
		<div class="max-w-4xl mx-auto p-3 sm:p-4 flex flex-col gap-3">
			<!-- Header + progress -->
			<header class="bg-white rounded-xl border border-gray-200 p-4 flex flex-col gap-3">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h1 class="text-lg font-semibold text-gray-900">
						{{ mode === "edit" ? __("Edit packaging") : __("New item") }}
						<span v-if="mode === 'edit'" class="text-gray-500 font-normal" dir="auto">{{ editItem }}</span>
					</h1>
					<div class="flex items-center gap-2">
						<label v-if="w.profiles.value.length > 1" class="flex items-center gap-2 text-sm text-gray-700">
							<span>{{ __("POS Profile") }}</span>
							<select
								:value="w.profile.value"
								class="min-h-[44px] px-3 rounded-lg border border-gray-300 bg-white"
								data-testid="wizard-profile"
								@change="w.changeProfile($event.target.value)"
							>
								<option v-for="p in w.profiles.value" :key="p.name" :value="p.name">{{ p.name }}</option>
							</select>
						</label>
						<a
							href="/pos"
							class="min-h-[44px] px-3 inline-flex items-center rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-100"
						>{{ __("Back to till") }}</a>
					</div>
				</div>
				<div
					class="h-2 rounded-full bg-gray-200 overflow-hidden"
					role="progressbar"
					:aria-valuenow="progress"
					aria-valuemin="0"
					aria-valuemax="100"
					:aria-label="__('Progress')"
					data-testid="wizard-progress"
				>
					<div class="h-full bg-blue-600 transition-all" :style="{ width: `${progress}%` }" />
				</div>
				<ol class="flex flex-wrap gap-1 text-xs">
					<li v-for="(s, i) in w.steps" :key="s">
						<button
							type="button"
							class="px-2 py-1 rounded-full border min-h-[32px]"
							:class="
								s === w.step.value
									? 'bg-blue-600 text-white border-blue-600'
									: w.visited.value.has(s)
										? 'bg-white text-blue-700 border-blue-200 hover:bg-blue-50'
										: 'bg-gray-100 text-gray-400 border-gray-200 cursor-default'
							"
							:disabled="!w.visited.value.has(s) || !!w.result.value"
							:aria-current="s === w.step.value ? 'step' : undefined"
							@click="w.goTo(s)"
						>
							<bdi class="font-semibold">{{ i + 1 }}</bdi> {{ stepTitle(s) }}
						</button>
					</li>
				</ol>
			</header>

			<p v-if="offline" class="p-3 rounded-lg bg-orange-50 border border-orange-200 text-sm text-orange-800" role="alert">
				{{ __("The Item Wizard needs the server. Connect to the internet and try again.") }}
			</p>
			<p v-if="w.loadError.value" class="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 whitespace-pre-line" role="alert" data-testid="wizard-load-error">
				{{ w.loadError.value }}
			</p>

			<main v-if="w.defaults.value && !w.result.value" class="bg-white rounded-xl border border-gray-200 p-4 flex flex-col gap-4">
				<h2 class="text-base font-semibold text-gray-900" data-testid="wizard-step-title">
					<bdi>{{ w.stepIndex.value + 1 }}</bdi> · {{ stepTitle(w.step.value) }}
				</h2>

				<!-- 1. Start -->
				<section v-if="w.step.value === 'start'" class="flex flex-col gap-4">
					<p class="text-sm text-gray-600">{{ __("Pick how this item is bought and sold. You can change everything in the next steps.") }}</p>
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
						<button
							v-for="(p, i) in w.defaults.value.presets"
							:key="p.name"
							type="button"
							class="text-start p-3 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50 min-h-[44px] disabled:opacity-50"
							:disabled="w.busy.value"
							:data-testid="`wizard-preset-${i}`"
							@click="w.start('preset', p.name)"
						>
							<div class="font-medium text-gray-900" dir="auto">{{ presetName(p) }}</div>
							<div v-if="p.description" class="text-xs text-gray-500 mt-1">{{ __(p.description) }}</div>
						</button>
						<button
							type="button"
							class="text-start p-3 rounded-lg border border-dashed border-gray-300 hover:border-blue-400 hover:bg-blue-50 min-h-[44px] disabled:opacity-50"
							:disabled="w.busy.value"
							data-testid="wizard-blank"
							@click="w.start('blank')"
						>
							<div class="font-medium text-gray-900">{{ __("Start blank") }}</div>
						</button>
					</div>
					<div class="flex flex-col gap-2">
						<label class="text-sm font-medium text-gray-700" for="wizard-copy-search">{{ __("Copy from existing item") }}</label>
						<input
							id="wizard-copy-search"
							v-model="copyQuery"
							type="search"
							class="min-h-[44px] px-3 rounded-lg border border-gray-300"
							:placeholder="__('Search by item code or name')"
							@input="searchCopy"
						/>
						<ul v-if="copyResults.length" class="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-60 overflow-auto">
							<li v-for="item in copyResults" :key="item.name">
								<button type="button" class="w-full text-start px-3 py-2 min-h-[44px] hover:bg-blue-50" @click="w.start('copy', item.name)">
									<span class="font-medium" dir="auto">{{ item.item_name }}</span>
									<span class="text-xs text-gray-500 ms-2" dir="ltr">{{ item.name }} · {{ item.stock_uom }}</span>
								</button>
							</li>
						</ul>
					</div>
					<details class="border border-gray-200 rounded-lg p-3" data-testid="wizard-csv">
						<summary class="cursor-pointer text-sm font-medium text-gray-700">{{ __("Import many items from a CSV file") }}</summary>
						<div class="mt-3 flex flex-col gap-2 text-sm">
							<p class="text-gray-600">{{ __("One row per item, with the same questions as the wizard. Rows with problems are not created; the others are.") }}</p>
							<div class="flex flex-wrap gap-2">
								<button type="button" class="min-h-[44px] px-3 rounded-lg border border-gray-300 hover:bg-gray-100" @click="downloadTemplate">
									{{ __("Download template") }}
								</button>
								<label class="min-h-[44px] px-3 rounded-lg bg-blue-600 text-white hover:bg-blue-700 inline-flex items-center cursor-pointer">
									{{ __("Import CSV") }}
									<input type="file" accept=".csv,text/csv" class="sr-only" data-testid="wizard-csv-file" @change="importCsv" />
								</label>
							</div>
							<table v-if="csvResults.length" class="w-full text-start text-xs" data-testid="wizard-csv-results">
								<thead>
									<tr class="text-gray-500"><th class="text-start p-1">{{ __("Row") }}</th><th class="text-start p-1">{{ __("Status") }}</th><th class="text-start p-1">{{ __("Item") }}</th><th class="text-start p-1">{{ __("Problem") }}</th></tr>
								</thead>
								<tbody>
									<tr v-for="r in csvResults" :key="r.row" :class="r.status === 'Created' ? 'text-green-700' : 'text-red-700'">
										<td class="p-1" dir="ltr">{{ r.row }}</td>
										<td class="p-1">{{ r.status === "Created" ? __("Created") : __("Failed") }}</td>
										<td class="p-1" dir="ltr">{{ r.item_code }}</td>
										<td class="p-1 whitespace-pre-line">{{ (r.errors || []).join("\n") }}</td>
									</tr>
								</tbody>
							</table>
						</div>
					</details>
				</section>

				<!-- 2. Basics -->
				<section v-if="w.step.value === 'basics'" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<label class="flex flex-col gap-1">
						<span class="text-sm font-medium text-gray-700">{{ __("Name in English") }} *</span>
						<input v-model="w.form.item_name" class="min-h-[44px] px-3 rounded-lg border border-gray-300" dir="ltr" data-testid="wizard-item-name" />
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-sm font-medium text-gray-700">{{ __("Name in Arabic") }}</span>
						<input v-model="w.form.item_name_ar" class="min-h-[44px] px-3 rounded-lg border border-gray-300" dir="rtl" lang="ar" data-testid="wizard-item-name-ar" />
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-sm font-medium text-gray-700">{{ __("Item group") }} *</span>
						<select v-model="w.form.item_group" class="min-h-[44px] px-3 rounded-lg border border-gray-300 bg-white" data-testid="wizard-item-group" @change="w.suggestCode()">
							<option value="" disabled>{{ __("Pick a group") }}</option>
							<option v-for="g in w.defaults.value.item_groups" :key="g" :value="g">{{ __(g) }}</option>
						</select>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-sm font-medium text-gray-700">{{ __("Brand") }}</span>
						<input v-model="w.form.brand" list="wizard-brands" class="min-h-[44px] px-3 rounded-lg border border-gray-300" dir="auto" />
						<datalist id="wizard-brands"><option v-for="b in w.defaults.value.brands" :key="b" :value="b" /></datalist>
					</label>
					<label v-if="!w.defaults.value.item_naming_by_series" class="flex flex-col gap-1">
						<span class="text-sm font-medium text-gray-700">{{ __("Item code") }}</span>
						<input
							v-model="w.form.item_code"
							class="min-h-[44px] px-3 rounded-lg border border-gray-300"
							dir="ltr"
							data-testid="wizard-item-code"
							@input="w.autoCode.value = !w.form.item_code"
						/>
						<span class="text-xs text-gray-500">{{ __("Made from the item group; you can change it.") }}</span>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-sm font-medium text-gray-700">{{ __("Image") }}</span>
						<input type="file" accept="image/*" class="min-h-[44px] text-sm" @change="uploadImage" />
						<img v-if="w.form.image" :src="w.form.image" alt="" class="h-16 w-16 object-cover rounded border" />
					</label>
				</section>

				<!-- 3. How you buy it -->
				<section v-if="w.step.value === 'buying'" class="flex flex-col gap-3">
					<label class="flex flex-col gap-1 max-w-xs">
						<span class="text-sm font-medium text-gray-700">{{ __("Stock unit (what you count and price in)") }}</span>
						<select
							:value="w.form.stock_uom"
							:disabled="mode === 'edit'"
							class="min-h-[44px] px-3 rounded-lg border border-gray-300 bg-white"
							data-testid="wizard-stock-uom"
							@change="w.setStockUom($event.target.value)"
						>
							<option v-for="u in unitNames" :key="u" :value="u">{{ __(u) }}</option>
						</select>
					</label>
					<p class="text-xs text-gray-500">{{ __("Weighed goods use Kg (liquids Litre). Gram and millilitre are only typed at the till, never priced.") }}</p>
					<div class="flex flex-col gap-2">
						<span class="text-sm font-medium text-gray-700">{{ __("Buying units") }}</span>
						<div v-for="(u, i) in w.form.buying_units" :key="i" class="flex flex-wrap items-center gap-2" data-testid="wizard-buying-row">
							<span class="text-sm text-gray-600">1</span>
							<input v-model="u.uom" list="wizard-uoms" class="min-h-[44px] w-32 px-3 rounded-lg border border-gray-300" :placeholder="__('Bag')" dir="auto" :aria-label="__('Buying unit')" data-testid="wizard-buying-uom" />
							<span class="text-sm text-gray-600">=</span>
							<input v-model="u.size" inputmode="decimal" dir="ltr" class="min-h-[44px] w-24 px-3 rounded-lg border border-gray-300" :aria-label="__('Size')" data-testid="wizard-buying-size" />
							<select v-model="u.parent_uom" class="min-h-[44px] px-3 rounded-lg border border-gray-300 bg-white" :aria-label="__('Contains')" data-testid="wizard-buying-parent">
								<option v-for="name in w.knownUnits.value.filter((x) => x !== u.uom)" :key="name" :value="name">{{ __(name) }}</option>
							</select>
							<button type="button" class="min-h-[44px] min-w-[44px] rounded-lg text-red-600 hover:bg-red-50" :aria-label="__('Remove')" @click="w.form.buying_units.splice(i, 1)">✕</button>
						</div>
						<button type="button" class="self-start min-h-[44px] px-3 rounded-lg border border-gray-300 text-sm hover:bg-gray-100" data-testid="wizard-add-buying" @click="w.addBuyingUnit()">
							+ {{ w.form.buying_units.length ? __("Add a second level (for example 1 Carton = 12 Packs)") : __("Add a buying unit") }}
						</button>
					</div>
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<label class="flex flex-col gap-1">
							<span class="text-sm font-medium text-gray-700">{{ __("Supplier") }}</span>
							<input v-model="w.form.supplier" list="wizard-suppliers" class="min-h-[44px] px-3 rounded-lg border border-gray-300" dir="auto" />
							<datalist id="wizard-suppliers"><option v-for="s in w.defaults.value.suppliers" :key="s" :value="s" /></datalist>
						</label>
						<label class="flex flex-col gap-1">
							<span class="text-sm font-medium text-gray-700">{{ __("Buying price per {0}", [__(w.calc.value.purchase_uom)]) }}</span>
							<input v-model="w.form.buying_price" inputmode="decimal" dir="ltr" class="min-h-[44px] px-3 rounded-lg border border-gray-300" data-testid="wizard-buying-price" />
							<span v-if="w.calc.value.cost_per_stock_uom !== null" class="text-xs text-gray-500" data-testid="wizard-cost-per-stock">
								{{ __("Cost per {0}: {1}", [__(w.form.stock_uom), money(w.calc.value.cost_per_stock_uom)]) }}
							</span>
						</label>
					</div>
				</section>

				<!-- 4. How you sell it -->
				<section v-if="w.step.value === 'selling'" class="flex flex-col gap-3">
					<p class="text-sm text-gray-600">{{ __("One row per unit the till sells. Size is how much of another unit is in one.") }}</p>
					<div
						v-for="(u, i) in w.form.selling_units"
						:key="i"
						class="flex flex-wrap items-center gap-2 p-2 rounded-lg border"
						:class="u.remove ? 'border-red-200 bg-red-50 opacity-70' : 'border-gray-200'"
						data-testid="wizard-selling-row"
					>
						<input v-model="u.uom" list="wizard-uoms" :disabled="!!u.existing" class="min-h-[44px] w-32 px-3 rounded-lg border border-gray-300" :aria-label="__('Selling unit')" dir="auto" data-testid="wizard-selling-uom" />
						<template v-if="u.uom !== w.form.stock_uom">
							<span class="text-sm text-gray-600">=</span>
							<input v-model="u.size" :disabled="!!u.existing" inputmode="decimal" dir="ltr" class="min-h-[44px] w-24 px-3 rounded-lg border border-gray-300" :aria-label="__('Size')" data-testid="wizard-selling-size" />
							<select v-model="u.size_uom" :disabled="!!u.existing" class="min-h-[44px] px-3 rounded-lg border border-gray-300 bg-white" :aria-label="__('Size unit')" data-testid="wizard-selling-size-uom">
								<option v-for="name in w.knownUnits.value" :key="name" :value="name">{{ __(name) }}</option>
							</select>
							<span v-if="factorOf(u.uom)" class="text-xs text-gray-500" dir="ltr">= {{ qty(factorOf(u.uom)) }} {{ __(w.form.stock_uom) }}</span>
						</template>
						<span v-else class="text-xs text-gray-500">{{ __("stock unit") }}</span>
						<label class="flex items-center gap-1 text-sm ms-auto min-h-[44px]">
							<input v-model="u.priced" type="checkbox" :true-value="1" :false-value="0" class="w-5 h-5" />
							{{ __("Has its own price") }}
						</label>
						<label v-if="u.existing" class="flex items-center gap-1 text-sm text-red-700 min-h-[44px]">
							<input v-model="u.remove" type="checkbox" :true-value="1" :false-value="0" class="w-5 h-5" data-testid="wizard-selling-remove" />
							{{ __("Stop selling") }}
						</label>
						<button v-else type="button" class="min-h-[44px] min-w-[44px] rounded-lg text-red-600 hover:bg-red-50" :aria-label="__('Remove')" @click="w.form.selling_units.splice(i, 1)">✕</button>
					</div>
					<div v-if="w.entryUnit.value" class="p-2 rounded-lg bg-blue-50 border border-blue-100 text-sm text-blue-900" data-testid="wizard-entry-unit">
						{{ __("{0} entry: the cashier can type the weight in {0}; the cart line stays in {1} at the price per {1}.", [__(w.entryUnit.value.uom), __(w.form.stock_uom)]) }}
					</div>
					<button type="button" class="self-start min-h-[44px] px-3 rounded-lg border border-gray-300 text-sm hover:bg-gray-100" data-testid="wizard-add-selling" @click="w.addSellingUnit()">
						+ {{ __("Add a selling unit") }}
					</button>
					<div v-if="w.entryUnit.value && w.defaults.value.scale_rules.length" class="flex flex-wrap items-center gap-3 p-2 rounded-lg border border-gray-200">
						<label class="flex items-center gap-2 text-sm min-h-[44px]">
							<input v-model="w.form.sold_on_scale" type="checkbox" :true-value="1" :false-value="0" :disabled="mode === 'edit' && !!w.form.scale_plu" class="w-5 h-5" data-testid="wizard-sold-on-scale" />
							{{ __("Sold on the scale") }}
						</label>
						<template v-if="w.form.sold_on_scale">
							<select v-model="w.form.scale_rule" class="min-h-[44px] px-3 rounded-lg border border-gray-300 bg-white" :aria-label="__('Scale barcode rule')">
								<option v-for="r in w.defaults.value.scale_rules" :key="r.name" :value="r.name">{{ r.name }}</option>
							</select>
							<label class="flex items-center gap-2 text-sm">
								{{ __("Scale PLU") }}
								<input v-model="w.form.scale_plu" :disabled="mode === 'edit' && !!editPlu" :placeholder="w.defaults.value.next_scale_plu" inputmode="numeric" dir="ltr" class="min-h-[44px] w-28 px-3 rounded-lg border border-gray-300" data-testid="wizard-scale-plu" />
							</label>
						</template>
					</div>
				</section>

				<!-- 5. Prices -->
				<section v-if="w.step.value === 'prices'" class="flex flex-col gap-3">
					<div class="flex flex-wrap gap-4">
						<label class="flex items-center gap-2 text-sm min-h-[44px]">
							<input v-model="w.form.price_mode" type="radio" value="price" class="w-5 h-5" />
							{{ __("Price per {0}", [__(w.form.stock_uom)]) }}
						</label>
						<label class="flex items-center gap-2 text-sm min-h-[44px]">
							<input v-model="w.form.price_mode" type="radio" value="margin" class="w-5 h-5" data-testid="wizard-mode-margin" />
							{{ __("Margin % over cost") }}
						</label>
					</div>
					<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
						<label v-if="w.form.price_mode === 'price'" class="flex flex-col gap-1">
							<span class="text-sm font-medium text-gray-700">{{ __("Price per {0}", [__(w.form.stock_uom)]) }}</span>
							<input v-model="w.form.base_price" inputmode="decimal" dir="ltr" class="min-h-[44px] px-3 rounded-lg border border-gray-300" data-testid="wizard-base-price" @input="w.schedulePreview()" />
						</label>
						<label v-else class="flex flex-col gap-1">
							<span class="text-sm font-medium text-gray-700">{{ __("Margin %") }}</span>
							<input v-model="w.form.margin_pct" inputmode="decimal" dir="ltr" class="min-h-[44px] px-3 rounded-lg border border-gray-300" data-testid="wizard-margin" @input="w.schedulePreview()" />
						</label>
						<fieldset class="flex flex-col gap-1">
							<legend class="text-sm font-medium text-gray-700">{{ __("Do these prices include VAT?") }}</legend>
							<div class="flex gap-3">
								<label class="flex items-center gap-1 text-sm min-h-[44px]"><input v-model="w.form.prices_include_vat" type="radio" :value="1" class="w-5 h-5" data-testid="wizard-incl-vat" /> {{ __("Yes") }}</label>
								<label class="flex items-center gap-1 text-sm min-h-[44px]"><input v-model="w.form.prices_include_vat" type="radio" :value="0" class="w-5 h-5" /> {{ __("No") }}</label>
							</div>
						</fieldset>
						<label class="flex flex-col gap-1">
							<span class="text-sm font-medium text-gray-700">{{ __("VAT") }}</span>
							<select v-model="w.form.item_tax_template" class="min-h-[44px] px-3 rounded-lg border border-gray-300 bg-white" data-testid="wizard-vat">
								<option v-for="t in w.defaults.value.tax_templates" :key="t.name" :value="t.name">{{ t.title || t.name }} ({{ t.rate }}%)</option>
							</select>
						</label>
					</div>
					<div class="overflow-x-auto">
						<table class="w-full text-sm" data-testid="wizard-price-table">
							<thead>
								<tr class="text-gray-500 text-xs">
									<th class="text-start p-2">{{ __("Unit") }}</th>
									<th class="text-end p-2">{{ __("Calculated") }}</th>
									<th class="text-end p-2">{{ __("Price") }}</th>
									<th class="text-end p-2">{{ __("Cost") }}</th>
									<th class="text-end p-2">{{ __("Margin") }}</th>
									<th class="text-end p-2">{{ __("Customer pays") }}</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="row in w.calc.value.units" :key="row.uom" class="border-t border-gray-100" :class="belowCost(row.uom) ? 'bg-red-50 text-red-800' : ''" :data-uom="row.uom" data-testid="wizard-price-row">
									<td class="p-2">{{ __(row.uom) }} <span class="text-xs text-gray-500" dir="ltr">({{ qty(row.factor) }} {{ __(w.form.stock_uom) }})</span></td>
									<td class="p-2 text-end" dir="ltr">{{ row.calculated === null ? "—" : money(row.calculated) }}</td>
									<td class="p-2 text-end">
										<input
											v-if="row.priced"
											:value="unitRow(row.uom)?.price"
											:placeholder="row.calculated === null ? '' : row.calculated.toFixed(2)"
											inputmode="decimal"
											dir="ltr"
											class="min-h-[44px] w-28 px-2 rounded-lg border border-gray-300 text-end"
											:aria-label="__('Price per {0}', [__(row.uom)])"
											data-testid="wizard-unit-price"
											@input="setUnitPrice(row.uom, $event.target.value)"
										/>
										<span v-else class="text-xs text-gray-500">{{ __("from the price per {0}", [__(w.form.stock_uom)]) }}</span>
									</td>
									<td class="p-2 text-end" dir="ltr">{{ row.cost === null ? "—" : money(row.cost) }}</td>
									<td class="p-2 text-end" dir="ltr">{{ row.margin_pct === null ? "—" : `${row.margin_pct}%` }}</td>
									<td class="p-2 text-end font-medium" dir="ltr" data-testid="wizard-shelf-price">{{ row.shelf_price === null ? "—" : money(row.shelf_price) }}</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p class="text-xs text-gray-500">{{ __("Prices are stored per unit in {0}. Customer pays = price with VAT as the till charges it.", [w.defaults.value.profile.selling_price_list]) }}</p>
				</section>

				<!-- 6. Barcodes -->
				<section v-if="w.step.value === 'barcodes'" class="flex flex-col gap-2">
					<p class="text-sm text-gray-600">{{ __("Scan or type the barcode of each unit, or press Generate for an internal barcode.") }}</p>
					<div v-for="u in liveUnits" :key="u.uom" class="flex flex-wrap items-center gap-2" data-testid="wizard-barcode-row" :data-uom="u.uom">
						<span class="w-28 text-sm font-medium">{{ __(u.uom) }}</span>
						<input v-model="u.barcode" dir="ltr" class="min-h-[44px] w-56 px-3 rounded-lg border border-gray-300 font-mono" :aria-label="__('Barcode for {0}', [__(u.uom)])" data-testid="wizard-barcode" />
						<button type="button" class="min-h-[44px] px-3 rounded-lg border border-gray-300 text-sm hover:bg-gray-100" data-testid="wizard-generate" @click="generate(u)">
							{{ __("Generate") }}
						</button>
					</div>
				</section>

				<!-- 7. Opening stock -->
				<section v-if="w.step.value === 'stock'" class="flex flex-col gap-3">
					<p class="text-sm text-gray-600">{{ __("Optional. Leave the quantity empty if you have no stock yet.") }}</p>
					<div class="grid grid-cols-1 sm:grid-cols-4 gap-3">
						<label class="flex flex-col gap-1">
							<span class="text-sm font-medium text-gray-700">{{ __("Quantity") }}</span>
							<input v-model="w.form.opening_stock.qty" inputmode="decimal" dir="ltr" class="min-h-[44px] px-3 rounded-lg border border-gray-300" data-testid="wizard-stock-qty" />
						</label>
						<label class="flex flex-col gap-1">
							<span class="text-sm font-medium text-gray-700">{{ __("Unit") }}</span>
							<select v-model="w.form.opening_stock.uom" class="min-h-[44px] px-3 rounded-lg border border-gray-300 bg-white" data-testid="wizard-stock-uom-select">
								<option v-for="name in Object.keys(w.calc.value.factors)" :key="name" :value="name">{{ __(name) }}</option>
							</select>
						</label>
						<label class="flex flex-col gap-1">
							<span class="text-sm font-medium text-gray-700">{{ __("Warehouse") }}</span>
							<select v-model="w.form.opening_stock.warehouse" class="min-h-[44px] px-3 rounded-lg border border-gray-300 bg-white" data-testid="wizard-warehouse">
								<option v-for="wh in w.defaults.value.warehouses" :key="wh" :value="wh">{{ wh }}</option>
							</select>
						</label>
						<label class="flex flex-col gap-1">
							<span class="text-sm font-medium text-gray-700">{{ __("Cost per {0}", [__(w.form.opening_stock.uom || w.calc.value.purchase_uom)]) }}</span>
							<input v-model="w.form.opening_stock.cost" :placeholder="defaultCost" inputmode="decimal" dir="ltr" class="min-h-[44px] px-3 rounded-lg border border-gray-300" />
						</label>
					</div>
					<p v-if="w.calc.value.opening_stock_qty" class="text-sm text-gray-800" data-testid="wizard-stock-converted">
						{{ __("Stock after Create: {0} {1}", [qty(w.calc.value.opening_stock_qty), __(w.form.stock_uom)]) }}
					</p>
				</section>

				<!-- 8. Review -->
				<section v-if="w.step.value === 'review'" class="flex flex-col gap-3 text-sm" data-testid="wizard-review">
					<dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
						<template v-if="mode !== 'edit'">
							<dt class="text-gray-500">{{ __("Item") }}</dt><dd dir="auto">{{ w.form.item_name }} <span v-if="w.form.item_name_ar" dir="rtl">/ {{ w.form.item_name_ar }}</span></dd>
							<dt class="text-gray-500">{{ __("Item code") }}</dt><dd dir="ltr" class="text-start">{{ w.form.item_code || __("(set by ERPNext)") }}</dd>
							<dt class="text-gray-500">{{ __("Item group") }}</dt><dd>{{ __(w.form.item_group) }}</dd>
						</template>
						<dt class="text-gray-500">{{ __("Stock unit") }}</dt><dd>{{ __(w.form.stock_uom) }}</dd>
						<dt class="text-gray-500">{{ __("Buying") }}</dt>
						<dd>
							<span v-for="u in w.form.buying_units" :key="u.uom" class="block" dir="auto">1 {{ __(u.uom) }} = {{ u.size }} {{ __(u.parent_uom) }}</span>
							<span v-if="w.form.buying_price">{{ __("Buying price per {0}", [__(w.calc.value.purchase_uom)]) }}: {{ money(Number(w.form.buying_price)) }}</span>
						</dd>
						<dt class="text-gray-500">{{ __("VAT") }}</dt><dd>{{ w.form.item_tax_template }}</dd>
						<template v-if="w.form.sold_on_scale">
							<dt class="text-gray-500">{{ __("Scale PLU") }}</dt><dd dir="ltr" class="text-start">{{ w.form.scale_plu || w.defaults.value.next_scale_plu }}</dd>
						</template>
						<template v-if="mode !== 'edit' && w.calc.value.opening_stock_qty">
							<dt class="text-gray-500">{{ __("Opening stock") }}</dt>
							<dd>{{ w.form.opening_stock.qty }} {{ __(w.form.opening_stock.uom) }} = {{ qty(w.calc.value.opening_stock_qty) }} {{ __(w.form.stock_uom) }} · {{ w.form.opening_stock.warehouse }}</dd>
						</template>
					</dl>
					<table class="w-full">
						<thead><tr class="text-gray-500 text-xs"><th class="text-start p-1">{{ __("Unit") }}</th><th class="text-end p-1">{{ __("Customer pays") }}</th><th class="text-start p-1">{{ __("Barcode") }}</th></tr></thead>
						<tbody>
							<tr v-for="row in w.calc.value.units" :key="row.uom" class="border-t border-gray-100" data-testid="wizard-review-row">
								<td class="p-1">{{ __(row.uom) }}</td>
								<td class="p-1 text-end" dir="ltr">{{ row.shelf_price === null ? "—" : money(row.shelf_price) }}</td>
								<td class="p-1 font-mono" dir="ltr">{{ unitRow(row.uom)?.barcode }}</td>
							</tr>
							<tr v-for="u in removedUnits" :key="`removed-${u.uom}`" class="border-t border-gray-100 text-red-700">
								<td class="p-1">{{ __(u.uom) }}</td><td class="p-1" colspan="2">{{ __("Stops selling: its price ends and its barcode is disabled.") }}</td>
							</tr>
						</tbody>
					</table>
					<p v-if="w.entryUnit.value" class="text-gray-600">{{ __("{0} entry at the till: 250 {1} = 0.250 {2}.", [__(w.entryUnit.value.uom), w.entryUnit.value.symbol, __(w.form.stock_uom)]) }}</p>
				</section>

				<!-- Issues of this step -->
				<ul v-if="w.issues.value.errors.length" class="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 list-disc ps-6 whitespace-pre-line" role="alert" data-testid="wizard-errors">
					<li v-for="(e, i) in w.issues.value.errors" :key="i">{{ issueMessage(e) }}</li>
				</ul>
				<ul v-if="stepWarnings.length" class="p-3 rounded-lg bg-red-50 border border-red-300 text-sm text-red-700 list-disc ps-6" role="status" data-testid="wizard-warnings">
					<li v-for="(e, i) in stepWarnings" :key="i">{{ issueMessage(e) }}</li>
				</ul>
			</main>

			<!-- Done -->
			<section v-if="w.result.value" class="bg-white rounded-xl border border-green-200 p-4 flex flex-col gap-3" data-testid="wizard-done">
				<h2 class="text-base font-semibold text-green-800">
					{{ mode === "edit" ? __("Packaging saved for {0}", [w.result.value.item_code]) : __("Item {0} created", [w.result.value.item_code]) }}
				</h2>
				<ul class="text-sm text-gray-700 list-disc ps-6" data-testid="wizard-created">
					<li v-for="(c, i) in doneLines" :key="i" dir="auto">{{ c }}</li>
				</ul>
				<div class="flex flex-wrap gap-2">
					<button type="button" class="min-h-[44px] px-3 rounded-lg bg-blue-600 text-white hover:bg-blue-700" data-testid="wizard-print-labels" @click="openLabels">{{ __("Print labels") }}</button>
					<button v-if="mode !== 'edit'" type="button" class="min-h-[44px] px-3 rounded-lg border border-gray-300 hover:bg-gray-100" data-testid="wizard-another" @click="w.another()">{{ __("Create another like this") }}</button>
					<button v-if="mode !== 'edit'" type="button" class="min-h-[44px] px-3 rounded-lg border border-gray-300 hover:bg-gray-100" @click="savePreset">{{ __("Save as preset") }}</button>
					<a :href="`/app/item/${encodeURIComponent(w.result.value.item_code)}`" target="_blank" rel="noopener" class="min-h-[44px] px-3 inline-flex items-center rounded-lg border border-gray-300 hover:bg-gray-100">{{ __("Open the item") }}</a>
				</div>
				<p v-if="presetMessage" class="text-sm" :class="presetError ? 'text-red-700' : 'text-green-700'" role="status">{{ presetMessage }}</p>
			</section>
		</div>

		<datalist id="wizard-uoms"><option v-for="u in unitNames" :key="u" :value="u" /></datalist>

		<!-- Back / Next -->
		<footer v-if="w.defaults.value && !w.result.value" class="fixed bottom-0 inset-x-0 bg-white border-t border-gray-200 p-3">
			<div class="max-w-4xl mx-auto flex items-center justify-between gap-2">
				<button type="button" class="min-h-[44px] px-4 rounded-lg border border-gray-300 hover:bg-gray-100 disabled:opacity-40" :disabled="w.stepIndex.value === 0 || w.busy.value" data-testid="wizard-back" @click="w.back()">
					{{ __("Back") }}
				</button>
				<span v-if="w.busy.value" class="text-sm text-gray-500" role="status">{{ __("Checking…") }}</span>
				<button
					v-if="w.step.value === 'review'"
					type="button"
					class="min-h-[44px] px-5 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700 disabled:opacity-50"
					:disabled="w.busy.value || offline"
					data-testid="wizard-create"
					@click="w.submit()"
				>
					{{ mode === "edit" ? __("Save changes") : __("Create") }}
				</button>
				<button
					v-else-if="w.step.value !== 'start'"
					type="button"
					class="min-h-[44px] px-5 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
					:disabled="w.busy.value || offline"
					data-testid="wizard-next"
					@click="w.next()"
				>
					{{ __("Next") }}
				</button>
			</div>
		</footer>

		<Dialog v-model="labelsOpen" :options="{ title: __('Print Labels'), size: '3xl' }">
			<template #body-content>
				<LabelPrintPanel v-if="labelsOpen && labelStore.profile === w.profile.value && !labelStore.loading" :initial-rows="labelRows" />
			</template>
		</Dialog>
	</div>
</template>

<script setup>
import LabelPrintPanel from "@/plus/components/LabelPrintPanel.vue"
import { issueMessage, stepTitle } from "@/plus/itemWizard/messages"
import { useItemWizard } from "@/plus/itemWizard/useItemWizard"
import { usePlusLabelStore } from "@/plus/labels/labelStore"
import { formatMoney } from "@/plus/core/money"
import { progressPercent } from "@/plus/core/itemWizard"
import { isOffline } from "@/utils/offline"
import { Dialog } from "frappe-ui"
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useRoute } from "vue-router"

const route = useRoute()
const mode = route.path.startsWith("/items/edit") ? "edit" : "new"
const editItem = String(route.query.item || "")
const w = useItemWizard({ mode, editItem })
const labelStore = usePlusLabelStore()

const offline = ref(isOffline())
const copyQuery = ref("")
const copyResults = ref([])
const csvResults = ref([])
const labelsOpen = ref(false)
const labelRows = ref([])
const presetMessage = ref("")
const presetError = ref(false)
const editPlu = ref("")

const progress = computed(() => progressPercent(w.step.value, w.steps))
const unitNames = computed(() => {
	const names = new Set((w.defaults.value?.uoms || []).map((u) => u.name))
	for (const u of [
		"Kg",
		"Litre",
		"Nos",
		"Bag",
		"Sack",
		"Carton",
		"Pack",
		"Drum",
		"Can",
	])
		names.add(u)
	const entry = w.entryUnit.value?.uom
	return [...names]
		.filter((n) => n !== entry || w.step.value === "buying")
		.sort()
})
const liveUnits = computed(() =>
	w.form.selling_units.filter((u) => u.uom && !u.remove),
)
const removedUnits = computed(() =>
	w.form.selling_units.filter((u) => u.uom && u.remove),
)
const stepWarnings = computed(() => {
	if (w.step.value === "prices" || w.step.value === "review") {
		const server = w.serverPreview.value
		return server?.warnings?.length !== undefined
			? server.warnings
			: w.calc.value.warnings
	}
	return w.issues.value.warnings || []
})
const defaultCost = computed(() => {
	const unit = w.form.opening_stock.uom || w.calc.value.purchase_uom
	const perStock = w.calc.value.cost_per_stock_uom
	const f = w.calc.value.factors[unit]
	return perStock !== null && f ? (perStock * f).toFixed(2) : ""
})
const doneLines = computed(() => {
	const out = w.result.value
	if (!out) return []
	const actions = {
		added: __("Added"),
		created: __("Created"),
		disabled: __("Disabled"),
		enabled: __("Enabled"),
		ended: __("Price ended"),
		price: __("Price set"),
		set: __("Set"),
	}
	if (out.changes)
		return out.changes.map(
			(c) =>
				`${actions[c.action] || c.action}: ${__(c.doctype)} ${c.uom || c.barcode || c.value || c.name || ""}`,
		)
	return (out.created || []).map((c) => {
		if (c.doctype === "Item Price")
			return `${__("Item Price")}: ${__(c.uom)} ${money(c.rate)} (${c.price_list})`
		if (c.doctype === "Stock Entry")
			return `${__("Stock Entry")} ${c.name}: ${qty(c.qty)} ${__(c.uom)}`
		if (c.doctype === "Item Barcode")
			return `${__("Barcode")} ${c.name} (${__(c.uom)})`
		return `${__(c.doctype)}: ${c.name}`
	})
})

function money(v) {
	return formatMoney(
		Number(v) || 0,
		w.defaults.value?.profile?.currency || "AED",
		{
			lang: document.documentElement.lang,
			mode: localStorage.getItem("pos0001_currency_symbol"),
		},
	)
}
function qty(v) {
	return String(Number(Number(v).toFixed(6)))
}
function presetName(p) {
	const ar = document.documentElement.lang === "ar" && p.preset_name_ar
	return ar ? p.preset_name_ar : __(p.preset_name)
}
function factorOf(uom) {
	return w.calc.value.factors[uom] || null
}
function unitRow(uom) {
	return w.form.selling_units.find((u) => u.uom === uom && !u.remove)
}
function setUnitPrice(uom, value) {
	const row = unitRow(uom)
	if (row) row.price = value
	w.schedulePreview()
}
function belowCost(uom) {
	return stepWarnings.value.some(
		(x) => x.code === "below_cost" && x.uom === uom,
	)
}

let searchTimer = null
function searchCopy() {
	clearTimeout(searchTimer)
	searchTimer = setTimeout(async () => {
		copyResults.value = copyQuery.value.trim()
			? await w.searchItems(copyQuery.value.trim())
			: []
	}, 250)
}

async function generate(unit) {
	try {
		await w.generateBarcode(unit)
	} catch (e) {
		w.issues.value = {
			errors: [
				{
					code: "server",
					message: String(e?.messages?.[0] || e?.message || e),
				},
			],
			warnings: [],
		}
	}
}

async function uploadImage(event) {
	const file = event.target.files?.[0]
	if (!file) return
	const data = new FormData()
	data.append("file", file, file.name)
	data.append("is_private", "0")
	data.append("folder", "Home")
	const res = await fetch("/api/method/upload_file", {
		method: "POST",
		body: data,
		headers: { "X-Frappe-CSRF-Token": window.csrf_token || "" },
	})
	const body = await res.json().catch(() => ({}))
	if (res.ok && body?.message?.file_url) w.form.image = body.message.file_url
	else
		w.issues.value = {
			errors: [
				{
					code: "server",
					message: __("The image could not be uploaded. Try a smaller file."),
				},
			],
			warnings: [],
		}
}

async function downloadTemplate() {
	const out = await w.csvTemplate()
	const blob = new Blob([`﻿${out.content}`], { type: "text/csv;charset=utf-8" })
	const a = document.createElement("a")
	a.href = URL.createObjectURL(blob)
	a.download = out.filename
	a.click()
	URL.revokeObjectURL(a.href)
}

async function importCsv(event) {
	const file = event.target.files?.[0]
	if (!file) return
	try {
		csvResults.value = (await w.importCsv(await file.text())) || []
	} catch (e) {
		csvResults.value = [
			{
				row: "-",
				status: "Failed",
				item_code: "",
				errors: [String(e?.messages?.[0] || e?.message || e)],
			},
		]
	}
	event.target.value = ""
}

async function openLabels() {
	labelRows.value = w.calc.value.units.map((u) => ({
		item_code: w.result.value.item_code,
		uom: u.uom,
		qty: 1,
	}))
	await labelStore.load(w.profile.value)
	labelsOpen.value = true
}

async function savePreset() {
	const name = window.prompt(
		__("Name of the new preset"),
		w.form.item_group ? `${w.form.item_group} (${w.form.stock_uom})` : "",
	)
	if (!name) return
	try {
		await w.savePreset(name)
		presetError.value = false
		presetMessage.value = __("Preset {0} saved.", [name])
	} catch (e) {
		presetError.value = true
		presetMessage.value = String(e?.messages?.[0] || e?.message || e)
	}
}

watch(
	() => w.step.value,
	(s) => {
		if (s === "prices" || s === "review") w.schedulePreview()
	},
)

function onOnline() {
	offline.value = isOffline()
}

onBeforeUnmount(() => {
	window.removeEventListener("online", onOnline)
	window.removeEventListener("offline", onOnline)
})

onMounted(async () => {
	window.addEventListener("online", onOnline)
	window.addEventListener("offline", onOnline)
	await w.init()
	editPlu.value = mode === "edit" ? w.form.scale_plu : ""
})
</script>
