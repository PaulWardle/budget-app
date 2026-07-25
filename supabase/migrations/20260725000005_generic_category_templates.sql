-- Genericise the starter category templates: these seed every new user's
-- category tree, so they must not carry personal categories. Existing users'
-- own categories are untouched — this only affects future sign-ups.
update public.category_templates set name = 'Hobbies' where name = 'Motorcycling';
delete from public.category_templates where name = 'TRT';
